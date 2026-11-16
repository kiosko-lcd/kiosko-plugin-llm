// Written by kiosko's scripts/scaffold-plugin-repos.ts: every widget paints with
// its demo data at several sizes, in every theme and language, without throwing.
// `kiosko plugins check` shows the rest (spills, slow paints, conventions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlugin } from '@kiosko/sdk/testing';
import plugin from './index.ts';

test('every widget paints with its demo data, at every size, theme and language, without throwing', () => {
  assert.deepEqual(checkPlugin(plugin).filter((i) => /threw/.test(i.problem)), []);
});
