// sqlx::migrate! embeds backend/migrations at compile time, and a new file
// with no Rust change otherwise leaves the crate "fresh": the binary would
// ship without it (BIRDTEST_LESSONS_PLAN.md MIG-1).
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
