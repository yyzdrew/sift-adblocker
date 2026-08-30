// Minimal test harness. No dependencies, no build step.
//
// Renders results into the DOM so it is readable in a browser and scrapable by
// `chrome --headless --dump-dom`, which is how these run without Node.

const suites = [];
let current = null;

export function suite(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function test(name, fn) {
  if (!current) throw new Error('test() called outside suite()');
  current.tests.push({ name, fn });
}

class AssertionError extends Error {}

export function ok(value, msg = 'expected truthy') {
  if (!value) throw new AssertionError(`${msg} (got ${fmt(value)})`);
}

export function notOk(value, msg = 'expected falsy') {
  if (value) throw new AssertionError(`${msg} (got ${fmt(value)})`);
}

export function equal(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new AssertionError(
      `${msg}\n      expected: ${fmt(expected)}\n      actual:   ${fmt(actual)}`,
    );
  }
}

export function deepEqual(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new AssertionError(`${msg}\n      expected: ${b}\n      actual:   ${a}`);
  }
}

export function throws(fn, msg = 'expected a throw') {
  try {
    fn();
  } catch {
    return;
  }
  throw new AssertionError(msg);
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  return String(v);
}

/** Extra lines attached to the current running test's output. */
let noteSink = null;
export function note(text) {
  if (noteSink) noteSink.push(text);
}

export async function runAll(rootEl) {
  let passed = 0;
  let failed = 0;
  const transcript = [];
  const started = performance.now();

  for (const s of suites) {
    const section = document.createElement('section');
    transcript.push('', `--- ${s.name} ---`);
    const h = document.createElement('h2');
    h.textContent = s.name;
    section.appendChild(h);
    rootEl.appendChild(section);

    for (const t of s.tests) {
      const notes = [];
      noteSink = notes;
      const line = document.createElement('div');
      line.className = 'case';
      const t0 = performance.now();
      try {
        await t.fn();
        const ms = performance.now() - t0;
        passed++;
        line.classList.add('pass');
        line.textContent = `PASS  ${t.name}${ms > 50 ? `  (${ms.toFixed(0)}ms)` : ''}`;
      } catch (err) {
        failed++;
        line.classList.add('fail');
        const where = err instanceof AssertionError ? '' : `\n      ${err.stack || ''}`;
        line.textContent = `FAIL  ${t.name}\n      ${err.message}${where}`;
      } finally {
        noteSink = null;
      }
      section.appendChild(line);
      transcript.push(line.textContent);
      for (const n of notes) {
        const nd = document.createElement('div');
        nd.className = 'note';
        nd.textContent = `      ${n}`;
        section.appendChild(nd);
        transcript.push(`      ${n}`);
      }
    }
  }

  const elapsed = ((performance.now() - started) / 1000).toFixed(2);
  const summary = document.createElement('div');
  summary.id = 'summary';
  summary.className = failed === 0 ? 'ok' : 'bad';
  summary.textContent = failed === 0
    ? `ALL PASS - ${passed} tests in ${elapsed}s`
    : `FAILED - ${failed} of ${passed + failed} tests failed (${elapsed}s)`;
  rootEl.appendChild(summary);

  // Machine-readable markers for headless runs.
  document.title = failed === 0 ? `PASS ${passed}` : `FAIL ${failed}`;
  const done = document.createElement('div');
  done.id = 'done';
  done.textContent = failed === 0 ? 'DONE-PASS' : 'DONE-FAIL';
  rootEl.appendChild(done);

  // When driven by tools/run_tests.py, report back over HTTP. Scraping the DOM
  // instead would require --virtual-time-budget, which freezes performance.now()
  // and makes every benchmark read as zero.
  await report({ passed, failed, elapsedMs: performance.now() - started, lines: transcript });
}

export async function report(payload) {
  if (!new URLSearchParams(location.search).has('post')) return;
  try {
    await fetch('/_results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('could not post results', err);
  }
}
