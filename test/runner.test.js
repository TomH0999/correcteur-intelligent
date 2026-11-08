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
