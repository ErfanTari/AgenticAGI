---
code: HOW.PR-000031
nb: HOW
type: PR
name: Web Scraper with Memory Storage
status: active
updated: 2026-03-05
summary: Python script to scrape and save data to memory entries
---

# Web Scraper with Memory Storage

*Self-Correction on "No Markdown":* The instruction says "Output ONLY plain text. No markdown." This means I cannot use ```python to highlight the code block. I must output the raw characters of the script. However, since I am an AI text model, the interface might render newlines differently. I will ensure the output looks like a raw file content.

    *Wait, one more check:* "No markdown" usually means no `**bold**`, no `# headers`, no ` ``` code blocks`. The Python code itself contains characters that look like markdown sometimes (like `#` for comments), but those are part of the language syntax, not formatting instructions to the renderer. I will write the code as plain text lines.

    *Wait, another check:* "Start directly with the content itself." So no "Here is the script". Just `import requests`.

    *Wait, "memory entries":* I need to make sure the concept of memory entries is clear in the code structure. I'll create a list that acts as the memory store.

    *Let's write the code.*

    import requests
    from bs4 import BeautifulSoup
    from typing import List, Dict, Any

    class MemoryEntry:
        def __init__(self, url: str, title: str = None, content: str = None):
            self.url = url
            self.title = title
            self.content = content
            self.timestamp = None

        def to_dict(self) -> Dict[str, Any]:
            return {
                "url": self.url,
                "title": self.title,
                "content": self.content,
                "timestamp": self.timestamp
            }

    class Scraper:
        def __init__(self):
            self.memory_entries: List[MemoryEntry] = []

        def fetch_page(self, url: str) -> str:
            try:
                response = requests.get(url, timeout=10)
                response.raise_for_status()
                return response.text
            except requests.exceptions.RequestException as e:
                print(f"Error fetching {url}: {e}")
                return None

        def parse_page(self, html: str, url: str) -> MemoryEntry:
            try:
                soup = BeautifulSoup(html, 'html.parser')
                title_tag = soup.find('title') or soup.find('h1')
                title = title_tag.get_text(strip=True) if title_tag else "Unknown Title"
                
                # Extract main content paragraphs
                for script in soup(['script', 'style']):
                    script.decompose()
                
                content_tags = soup.find_all(['p', 'div'])
                content_parts = [tag.get_text(strip=True) for tag in content_tags if tag.get_text(strip=True)]
                content = " ".join(content_parts[:500])

                entry = MemoryEntry(url=url, title=title, content=content)
                return entry
            except Exception as e:
                print(f"Error parsing {url}: {e}")
                return None

        def store_entry(self, entry: MemoryEntry):
            if entry:
                self.memory_entries.append(entry)
                print(f"Stored entry for {entry.url}")

        def scrape_urls(self, urls: List[str]):
            for url in urls:
                html = self.fetch_page(url)
                if html:
                    entry = self.parse_page(html, url)
                    self.store_entry(entry)

    if __name__ == "__main__":
        config_urls = [
            "https://www.example.com",
            "https://www.python.org"
        ]

        scraper = Scraper()
        scraper.scrape_urls(config_urls)

        for entry in scraper.memory_entries:
            print(entry.to_dict())

    *Wait, I need to check if I am violating the "No markdown" rule by using code blocks.*
    The instruction says "Output ONLY plain text. No markdown."
    If I put the code inside ```python ... ```, that is markdown.
    So I must output the raw text of the script without the fencing.

    *Wait, one more constraint:* "No headers". This means no `# Title` at the top of the file either? Or does it mean no Markdown headers in the response? Usually, it means don't use `#` as a header marker for the document structure. However, Python comments start with `#`. I should avoid using `#` as a section header like `### Configuration`. I will just write the code.

    *Wait, "Start directly with the content itself."*
    Okay, I will begin with `import requests`.

    *Final check on constraints:*
    - Plain text only.
    - No markdown (no ```).
    - No HTML.
    - No preamble.
    - No headers (Markdown style #).
    - No bullets (- or *).
    - Just prose (code is considered content here, but formatted as plain text lines).

    Let's assemble the final output carefully to ensure no markdown formatting is applied by the system or me. I will just type the code.

    Wait, "No headers" could also mean no Python docstrings that look like headers? No, it likely refers to Markdown headers in the response text. But to be safe, I won't put any descriptive titles above the code.

    Also, "memory entries" implies a specific structure. I will ensure the class `MemoryEntry` is prominent.

    Okay, ready to generate.


import requests
from bs4 import BeautifulSoup
from typing import List, Dict, Any
from datetime import datetime

class MemoryEntry:
    def __init__(self, url: str, title: str = None, content: str = None):
        self.url = url
        self.title = title
        self.content = content
        self.timestamp = datetime.now().isoformat()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "title": self.title,
            "content": self.content,
            "timestamp": self.timestamp
        }

class WebScraper:
    def __init__(self):
        self.memory_entries: List[MemoryEntry] = []

    def fetch_page(self, url: str) -> str:
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
            response = requests.get(url, headers=headers, timeout=10)
