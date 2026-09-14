# Served timing sample

Milliseconds, first workload run after the other browser checks finished. This is a diagnostic sample, not a controlled speedup benchmark. The two nearest batches are deliberately submitted concurrently to verify queue accounting.

| Operation | Wall | Capture | Setup | Queue | Packing | Readback wait | CPU refinement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Deform: first host use | 462.400 | 23.400 | 416.700 | 0.200 | 0.900 | 17.500 | 0.000 |
| Deform: zero iterations | 20.500 | 20.300 | 0.100 | 0.000 | 0.000 | 0.000 | 0.000 |
| Nearest: target miss | 32.500 | 1.800 | 14.100 | 3.800 | 0.400 | 7.700 | 2.600 |
| Nearest: queued target hit | 43.100 | 1.400 | 0.400 | 27.400 | 0.200 | 11.700 | 1.200 |
| Rays: target hit | 10.000 | 1.600 | 0.100 | 0.000 | 0.500 | 5.500 | 1.800 |
| Segments: target hit | 10.800 | 1.500 | 0.000 | 0.100 | 0.400 | 6.000 | 2.000 |
| Nearest: empty batch | 0.100 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| Visibility | 364.900 | 231.500 | 0.000 | 0.100 | 56.600 | 18.000 | 26.600 |

Visibility compute-pass timestamps total **0.021376 ms**. They are not additive with the host phases.

View construction/capture before classification: **13.500 ms**. The explicit GPU classification call, including feature realization, took **365.200 ms**. A separate CPU snapshot took **71.300 ms**, followed by CPU classification at **48.800 ms**. The CPU reference runs after GPU classification and may benefit from warmed code/caches; no general performance ranking follows from this sample.

The report retains every phase, transfer volume, cache/dispatch counter, both worker runs, CPU/GPU interval comparison and analytic hit checks. Submission cost is not physical upload duration; readback wait includes queued GPU work and transfer completion. The second worker run is a reload, not a warm-device render.
