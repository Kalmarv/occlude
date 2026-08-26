//! Feature-gated stage timing for hotspot profiling (`--features profile`).
//! Zones accumulate wall time in a thread-local; `take()` drains them.
//! Single-threaded use only — run with `--no-default-features` so the
//! pipeline is serial, which also mirrors the wasm build exactly.

#[cfg(feature = "profile")]
mod imp {
    use std::cell::RefCell;
    use std::time::{Duration, Instant};

    thread_local! {
        static ZONES: RefCell<Vec<(&'static str, Duration)>> = const { RefCell::new(Vec::new()) };
    }

    pub struct Zone {
        name: &'static str,
        start: Instant,
    }

    impl Drop for Zone {
        fn drop(&mut self) {
            let d = self.start.elapsed();
            ZONES.with(|z| {
                let mut z = z.borrow_mut();
                if let Some(e) = z.iter_mut().find(|(n, _)| *n == self.name) {
                    e.1 += d;
                } else {
                    z.push((self.name, d));
                }
            });
        }
    }

    pub fn zone(name: &'static str) -> Zone {
        Zone { name, start: Instant::now() }
    }

    pub fn take() -> Vec<(&'static str, Duration)> {
        ZONES.with(|z| std::mem::take(&mut *z.borrow_mut()))
    }
}

#[cfg(feature = "profile")]
pub use imp::{take, zone, Zone};

#[cfg(not(feature = "profile"))]
pub struct Zone;

#[cfg(not(feature = "profile"))]
#[inline(always)]
pub fn zone(_name: &'static str) -> Zone {
    Zone
}

#[cfg(not(feature = "profile"))]
pub fn take() -> Vec<(&'static str, std::time::Duration)> {
    Vec::new()
}
