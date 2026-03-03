---
code: HOW.PR-000020
nb: HOW
type: PR
name: Implementation: fibonacci.js
status: active
updated: 2026-03-03
summary: Working fibonacci.js implementation, tests passed on attempt 3
---

# Implementation: fibonacci.js

## Working Solution

Tests passed on attempt 3.

### Code
```javascript
function fibonacci(n) {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    [a, b] = [b, a + b];
  }
  return b;
}

export default fibonacci;
export { fibonacci as fib };
```

### Test Output
```
All tests passed!
```
