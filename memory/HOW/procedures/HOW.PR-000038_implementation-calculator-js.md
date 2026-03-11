---
code: HOW.PR-000038
nb: HOW
type: PR
name: Implementation: calculator.js
status: active
updated: 2026-03-05
summary: Working calculator.js implementation, tests passed on attempt 2
---

# Implementation: calculator.js

## Working Solution

Tests passed on attempt 2.

### Code
```javascript
export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}

export function divide(a, b) {
  if (b === 0) {
    throw new Error('Division by zero');
  }
  return a / b;
}
```

### Test Output
```
All tests passed!
```
