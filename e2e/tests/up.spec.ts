import { test } from '@playwright/test';

// The Makefile's e2e-up-% targets run this alone to bring a pass's stack up
// before any journey starts: the suite's global setup does the work (up, seed,
// and a browser loading the log-in form), and this gives Playwright a test to
// run. It touches nothing, so another stack coming up beside it cannot fail it.
// @env keeps it out of the other passes.
test('@env @up the stack is up', () => {});
