//! Rate limits (PLAN.md § Authentication → Security generally).
//!
//! In-memory token buckets, per backend instance. Every limit is a bucket of
//! `n` tokens refilled at `n` per minute; a `429` carries `Retry-After`.

use std::collections::HashMap;
use std::hash::Hash;
use std::net::IpAddr;
use std::num::NonZeroU32;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use governor::clock::{Clock, DefaultClock};
use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};
use uuid::Uuid;

use crate::config::Config;
use crate::error::ApiError;

/// A keyed `governor` limiter that answers `429` with `Retry-After`.
pub struct Keyed<K: Hash + Eq + Clone> {
    limiter: DefaultKeyedRateLimiter<K>,
    clock: DefaultClock,
}

impl<K: Hash + Eq + Clone> Keyed<K> {
    pub fn per_minute(n: u32) -> Self {
        let n = NonZeroU32::new(n).expect("rates are validated as >= 1");
        Keyed {
            limiter: RateLimiter::keyed(Quota::per_minute(n)),
            clock: DefaultClock::default(),
        }
    }

    pub fn per_hour(n: u32) -> Self {
        let n = NonZeroU32::new(n).expect("rates are validated as >= 1");
        Keyed {
            limiter: RateLimiter::keyed(Quota::per_hour(n)),
            clock: DefaultClock::default(),
        }
    }

    pub fn check(&self, key: &K) -> Result<(), ApiError> {
        self.limiter
            .check_key(key)
            .map_err(|not_until| ApiError::TooManyRequests {
                retry_after_secs: ceil_secs(not_until.wait_time_from(self.clock.now())),
            })
    }

    /// Forgets every key whose bucket has refilled. `governor` keeps a key
    /// until it is told to look.
    pub fn prune(&self) {
        self.limiter.retain_recent();
        self.limiter.shrink_to_fit();
    }
}

fn ceil_secs(d: Duration) -> u64 {
    let s = d.as_secs() + u64::from(d.subsec_nanos() > 0);
    s.max(1)
}

/// A bucket whose token can be given back, for the login-failure limits: a
/// request takes a token from each bucket before any Argon2 verify, is refused
/// when either has none, and gives its tokens back when the verify succeeds.
/// So a successful login spends nothing, and requests arriving together cannot
/// all pass a bucket that holds fewer tokens than there are requests: a peek
/// before the verify and a take after it let every one of them through.
/// `governor` can only check-and-take, never refund (PQ-004). Same refill rule
/// as `governor`'s quota: `n` per minute, burst `n`.
pub struct FailureBuckets<K: Hash + Eq + Clone> {
    capacity: f64,
    per_sec: f64,
    buckets: Mutex<HashMap<K, (f64, Instant)>>,
}

impl<K: Hash + Eq + Clone> FailureBuckets<K> {
    pub fn per_minute(n: u32) -> Self {
        FailureBuckets {
            capacity: f64::from(n),
            per_sec: f64::from(n) / 60.0,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    fn level(&self, map: &HashMap<K, (f64, Instant)>, key: &K, now: Instant) -> f64 {
        match map.get(key) {
            None => self.capacity,
            Some(&(tokens, at)) => {
                (tokens + now.duration_since(at).as_secs_f64() * self.per_sec).min(self.capacity)
            }
        }
    }

    /// Takes a token, or answers `429` with the wait until there is one.
    pub fn reserve(&self, key: &K) -> Result<(), ApiError> {
        let now = Instant::now();
        let mut map = self.buckets.lock().expect("bucket lock");
        let level = self.level(&map, key, now);
        if level < 1.0 {
            return Err(ApiError::TooManyRequests {
                retry_after_secs: ((1.0 - level) / self.per_sec).ceil().max(1.0) as u64,
            });
        }
        map.insert(key.clone(), (level - 1.0, now));
        Ok(())
    }

    /// Gives back a token [`reserve`](Self::reserve) took.
    pub fn refund(&self, key: &K) {
        let now = Instant::now();
        let mut map = self.buckets.lock().expect("bucket lock");
        let level = (self.level(&map, key, now) + 1.0).min(self.capacity);
        if level >= self.capacity {
            map.remove(key);
        } else {
            map.insert(key.clone(), (level, now));
        }
    }

    /// Forgets every bucket that has refilled: a full bucket carries no state.
    pub fn prune(&self) {
        let now = Instant::now();
        let mut map = self.buckets.lock().expect("bucket lock");
        let (cap, per_sec) = (self.capacity, self.per_sec);
        map.retain(|_, (t, at)| *t + now.duration_since(*at).as_secs_f64() * per_sec < cap);
        map.shrink_to_fit();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.buckets.lock().expect("bucket lock").len()
    }
}

/// Every bucket, each with its named refill rate from Configuration.
pub struct Limiters {
    pub auth_ip: Keyed<IpAddr>,
    /// Password resets, `RESET_RATE_PER_HOUR` (5) an hour per key: `ip:` the
    /// caller and `em:` the address named, for asking; `tok:` the link, for
    /// setting; `pw:` the account, for each password typed behind a session
    /// (PLAN.md § Authentication).
    pub reset: Keyed<String>,
    pub catalog_ip: Keyed<IpAddr>,
    pub login_fail_ip: FailureBuckets<IpAddr>,
    pub login_fail_username: FailureBuckets<String>,
    pub sync: Keyed<Uuid>,
    pub download: Keyed<Uuid>,
    pub search: Keyed<Uuid>,
    pub export: Keyed<Uuid>,
    pub admin_upload: Keyed<Uuid>,
}

impl Limiters {
    pub fn new(c: &Config) -> Self {
        Limiters {
            auth_ip: Keyed::per_minute(c.auth_rate_per_ip_per_minute),
            reset: Keyed::per_hour(c.reset_rate_per_hour),
            catalog_ip: Keyed::per_minute(c.catalog_rate_per_minute),
            login_fail_ip: FailureBuckets::per_minute(c.login_failures_per_ip_per_minute),
            login_fail_username: FailureBuckets::per_minute(
                c.login_failures_per_username_per_minute,
            ),
            sync: Keyed::per_minute(c.sync_rate_per_minute),
            download: Keyed::per_minute(c.download_rate_per_minute),
            search: Keyed::per_minute(c.search_rate_per_minute),
            export: Keyed::per_minute(c.export_rate_per_minute),
            admin_upload: Keyed::per_minute(c.admin_upload_rate_per_minute),
        }
    }

    /// Drops the state of every bucket that has refilled, in every limiter.
    /// Run on a timer (`purge::spawn`): without it each map keeps an entry
    /// for every key it has ever seen.
    pub fn prune(&self) {
        self.auth_ip.prune();
        self.reset.prune();
        self.catalog_ip.prune();
        self.login_fail_ip.prune();
        self.login_fail_username.prune();
        self.sync.prune();
        self.download.prune();
        self.search.prune();
        self.export.prune();
        self.admin_upload.prune();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_bucket_refunds_what_it_reserved() {
        let b = FailureBuckets::<u8>::per_minute(2);
        // Reserved and given back, a token is never spent.
        for _ in 0..10 {
            assert!(b.reserve(&1).is_ok());
            b.refund(&1);
        }
        assert_eq!(b.len(), 0, "a full bucket carries no state");
        // Two reservations held at once are the whole bucket.
        assert!(b.reserve(&1).is_ok());
        assert!(b.reserve(&1).is_ok());
        assert!(matches!(b.reserve(&1), Err(ApiError::TooManyRequests { retry_after_secs }) if retry_after_secs >= 1));
        assert!(b.reserve(&2).is_ok());
        b.refund(&1);
        assert!(b.reserve(&1).is_ok());
    }

    #[test]
    fn pruning_forgets_refilled_buckets() {
        let b = FailureBuckets::<u8>::per_minute(2);
        b.reserve(&1).unwrap();
        b.prune();
        assert_eq!(b.len(), 1, "a spent token is remembered");
        b.refund(&1);
        b.reserve(&2).unwrap();
        b.buckets.lock().unwrap().get_mut(&2).unwrap().1 -= Duration::from_secs(120);
        b.prune();
        assert_eq!(b.len(), 0);

        let k = Keyed::<u8>::per_hour(1);
        assert!(k.check(&1).is_ok());
        k.prune();
        assert!(matches!(k.check(&1), Err(ApiError::TooManyRequests { .. })), "a spent key is kept");
    }

    #[test]
    fn keyed_limits_per_key() {
        let k = Keyed::<u8>::per_minute(1);
        assert!(k.check(&1).is_ok());
        assert!(matches!(k.check(&1), Err(ApiError::TooManyRequests { .. })));
        assert!(k.check(&2).is_ok());
    }
}
