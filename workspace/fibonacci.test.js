import assert from 'node:assert';
import { fib } from './fibonacci.js';

assert.ok(typeof fib === 'function', 'fib should be a function');

console.log('All tests passed!');