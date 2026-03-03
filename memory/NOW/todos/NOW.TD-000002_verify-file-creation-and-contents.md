---
code: NOW.TD-000002
nb: NOW
type: TD
name: Verify File Creation and Contents
status: active
updated: 2026-02-25
summary: Execute commands to generate data, write to file, and verify
---

# Verify File Creation and Contents

```bash
# Calculate 5 factorial
factorial=1
for i in {1..5}; do
  factorial=$((factorial * i))
 done

 # Get Python sorting algorithm info
 python_sort_info="Python\'s built-in sort uses Timsort: stable, O(n log n)"
 
 # Create file with results
 echo "5! = $factorial" > results.txt
 echo "$python_sort_info" >> results.txt

 # Verify contents
 cat results.txt
 ```
