---
code: HOW.PR-000034
nb: HOW
type: PR
name: Write Web Scraper with Memory Storage
status: active
updated: 2026-03-05
summary: Procedure for creating web scrapers that store data in memory
---

# Write Web Scraper with Memory Storage

*   Wait, if I put code in plain text, indentation matters. I must preserve spaces/tabs.
    *   Let's draft the content.
    *   Need to include: imports (requests, logging), function definition, try/except block, logging setup, return value (memory storage).
    *   Need clear instructions for saving to memory within the text/code comments or description.

    *   Refining the "Prose" constraint: If I output a code block without markdown fences, it might look like code but technically is plain text. The instruction says "No headers, no bullets". So I cannot have "# Code Example" as a header.
    *   I will write an introductory paragraph explaining the approach, then present the code line by line, ensuring no markdown backticks are used.

    *   Wait, looking closely at "Output ONLY plain text. No markdown." This means I cannot use `**bold**` or `*italic*` either.
    *   So the entire response must be raw characters (letters, numbers, symbols, newlines).
    *   I will write the explanation and the code in a way that flows as text.

    *   Plan:
        1. Start with an explanation of the script's purpose.
        2. Provide the Python code directly, ensuring indentation is preserved using spaces.
        3. Ensure no markdown fencing (```) is used.
        4. Ensure no headers like "## Code" are used.
        5. Ensure no bullet points.

    *   Wait, if I just output the code, is that prose? The prompt asks to "Write a Python web scraper... Include error handling, logging, and clear instructions for saving to memory."
    *   If I write the code with comments explaining the memory part, that satisfies the requirement.
    *   I will combine the explanation into the text flow before or after the code, but since it says "Start directly with the content itself", I should probably start with the code or the immediate instruction. Given "just prose", a narrative description of the script followed by the script is best.

    *   Actually, to be safe on "No markdown", I will avoid any formatting that looks like markdown.
    *   Let's construct the response.

    *   Wait, one more check: "Output ONLY plain text." This often implies no newlines either in some strict interpretations, but usually it means no rich text or markup. Newlines are necessary for code and paragraphs. I will use standard newlines.

    *   Structure:
        Paragraph 1: Introduction to the script functionality.
        Paragraph 2: The Python code itself (formatted as plain text).
        Paragraph 3: Instructions on how it saves to memory.

    *   Wait, if I separate them by paragraphs, is that "just prose"? Yes.
    *   I must ensure I don't use markdown for the code block. Just raw lines.

    *   Let's draft the text.
    *   Start with: This Python script demonstrates how to fetch data from a URL and store it in memory using standard libraries. It includes robust error handling and logging mechanisms to track execution status. The results are stored in a variable within the function scope, effectively saving them to memory for immediate use without writing to disk.

    *   Then the code:
    import requests
    import logging

    # Configure logging to output messages to the console
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)

    def fetch_data(url):
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            data = response.text
            logger.info(f'Successfully fetched data from {url}')
            return data
        except requests.exceptions.RequestException as e:
            logger.error(f'Failed to fetch data: {e}')
            raise

    if __name__ == main:
        target_url = https://example.com
        memory_storage = fetch_data(target_url)
        print(Data saved in memory variable named memory_storage)

    *   Wait, I need to make sure I don't use markdown. The text above uses `**` for bold which is markdown. I must remove that.
    *   Also "if __name__ == main" should be "if __name__ == '__main__'".
    *   I need to ensure the output is strictly plain text.

    *   Revised Plan:
        Write a continuous flow of text that includes the code. Since code requires indentation, I will use spaces. I will not wrap it in triple backticks. I will not bold any text.

    *   Wait, "Start directly with the content itself." means no "Here is the code:" preamble if possible, or just minimal prose.
    *   Okay, I will write the explanation and code as one continuous stream of plain text blocks separated by newlines.

    *   Let's check constraints again: "No markdown". This includes backticks. "No headers". No # symbols at start of line. "No bullets". No - or * lists.
    *   Okay, I will write the explanation and then the code block as plain text lines.

    *   Wait, if I output code with indentation, is that allowed? Yes, it's plain text characters (spaces).
    *   Let's assemble.

    This Python script provides a robust method for fetching web data and retaining it in memory. It utilizes the requests library to handle HTTP connections and includes comprehensive logging to track success or failure states. The fetched content is stored directly into a variable upon successful retrieval, ensuring that no intermediate files are created on the disk. Error handling is implemented using try-except blocks to catch network issues gracefully while logging specific error messages for debugging purposes.

    import requests
    import logging

    # Setup logging configuration to track application events
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)

    def fetch_and_store_data(url):
        memory_storage = None
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            # Data is stored in the variable below for immediate memory access
            memory_storage = response.text
            logger.info(f'Successfully fetched and stored data
