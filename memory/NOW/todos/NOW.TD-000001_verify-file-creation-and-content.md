---
code: NOW.TD-000001
nb: NOW
type: TD
name: Verify File Creation and Content
status: active
updated: 2026-02-25
summary: Execute commands to generate data, write to file, and verify
---

# Verify File Creation and Content

```bash
# Calculate 5 factorial
factorial=1
for i in {1..5}; do
  factorial=$((factorial * i))
 done

 # Get Python sorting algorithm info
 python_sort_info=$(python -c "import heapq; import random; print(f'\n'.join([str(sorted.__doc__), str(heapq.nlargest.__doc__), str(random.shuffle.__doc__)]))")

 # Combine and write to file
 echo "$python_sort_info" > results.txt
 echo "5! = $factorial" >> results.txt

 # Verify content
 cat results.txt
```
