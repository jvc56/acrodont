//! Time, for a search's deadline and an index's build time. `std::time::Instant`
//! panics on `wasm32-unknown-unknown`, so there the host supplies the clock:
//! `search-wasm` imports `env.now`, the page's `performance.now()`.

/// Milliseconds on a clock that only ever moves forward.
#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> f64 {
    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        fn now() -> f64;
    }
    // SAFETY: an import taking nothing and returning a number.
    unsafe { now() }
}

/// When a search gives up as "too broad" (PLAN.md § Search Engine → Limits).
pub trait Deadline {
    fn passed(&self) -> bool;
}

#[cfg(not(target_arch = "wasm32"))]
impl Deadline for std::time::Instant {
    fn passed(&self) -> bool {
        std::time::Instant::now() > *self
    }
}

/// A deadline on [`now_ms`]'s clock.
#[derive(Clone, Copy, Debug)]
pub struct AtMs(pub f64);

impl Deadline for AtMs {
    fn passed(&self) -> bool {
        now_ms() > self.0
    }
}

impl<D: Deadline + ?Sized> Deadline for &D {
    fn passed(&self) -> bool {
        (**self).passed()
    }
}
