const test = require('node:test');
const assert = require('node:assert');
const runner = require('../src/main/runner');

test('exécution Python, JavaScript, SQL et coupure des boucles infinies', async (t) => {
  t.after(() => runner.shutdown());
  const py = await runner.runCode({ language: 'python', code: 'n = int(input())\nprint(sum(range(n)))', stdin: '10' });
  assert.equal(py.stdout.trim(), '45');
  const err = await runner.runCode({ language: 'py', code: 'print(1/0)' });
  assert.ok(!err.ok);
  assert.match(err.stderr, /ZeroDivisionError/);
  const js = await runner.runCode({ language: 'js', code: 'console.log([1,2].map(x => x * 2))' });
  assert.equal(js.stdout.trim(), '[ 2, 4 ]');
  const sql = await runner.runCode({ language: 'sql', code: "CREATE TABLE c(id INT, nom TEXT); INSERT INTO c VALUES (1,'A'),(2,'B'); SELECT nom FROM c WHERE id = 2;" });
  assert.match(sql.stdout, /B/);
  const loop = await runner.runCode({ language: 'javascript', code: 'while (true) {}', timeoutMs: 1000 });
  assert.ok(!loop.ok);
  const cobol = await runner.runCode({ language: 'cobol', code: '' });
  assert.ok(cobol.unavailable);
});

test('exécutions simultanées : sorties non mélangées, programme suivant relancé après une boucle infinie', async (t) => {
  t.after(() => runner.shutdown());
  await runner.warmup();
  const res = await Promise.all([1, 2, 3].map((i) => runner.runCode({ language: 'python', code: `print("run ${i}")` })));
  assert.deepEqual(res.map((r) => r.stdout.trim()), ['run 1', 'run 2', 'run 3']);
  const t0 = Date.now();
  const [loop, next] = await Promise.all([
    runner.runCode({ language: 'python', code: 'while True: pass', timeoutMs: 1500 }),
    runner.runCode({ language: 'python', code: 'print("suivant")' })
  ]);
  assert.ok(loop.timedOut);
  assert.equal(next.stdout.trim(), 'suivant');
  assert.ok(Date.now() - t0 < 20000, 'moteur déjà chargé : pas de délai de chargement');
});
