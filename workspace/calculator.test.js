import assert from 'node:assert';
import { add } from './calculator.js';

assert.ok(typeof add === 'function', 'add should be a function');

console.log('All tests passed!');