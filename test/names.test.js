import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileName, safeFileName, cleanTitle } from '../src/lib/names.js';

test('builds a readable name with the site', () => {
  assert.equal(
    buildFileName('Aallonportin tulipalo | Paikalliset | Keskisuomalainen', 'https://www.ksml.fi/paikalliset/9888067', 'mp4'),
    'Aallonportin tulipalo - ksml.fi.mp4',
  );
  assert.equal(buildFileName('Uutinen', 'https://www.ksml.fi/a', 'mp4', 1), 'Uutinen - ksml.fi (2).mp4');
});

test('strips path tricks and unsafe characters', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'etc passwd');
  assert.equal(safeFileName('a‮gnp.exe'), 'agnp.exe');
  assert.equal(safeFileName('  ...  '), 'download');
  assert.equal(safeFileName('CON'), 'download');
  assert.equal(safeFileName('x'.repeat(500)).length, 120);
});

test('cleanTitle keeps the headline', () => {
  assert.equal(cleanTitle('Headline · Site'), 'Headline');
  assert.equal(cleanTitle('No separators here'), 'No separators here');
});
