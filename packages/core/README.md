# @crashlab/core

Simulation harness for CrashLab. Orchestrates all modules: virtual clock, seeded PRNG, scheduler, HTTP/TCP interceptors, virtual filesystem, and fault injector. Provides `Simulation` class with `scenario()`, `run({ seeds })`, and `replay({ seed, scenario })`. Includes `crashlab` CLI with `run` and `replay` commands.
