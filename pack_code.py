import os

# Configuration: Define what to ignore to keep the output clean for LLM context
IGNORE_DIRS = {'.git', 'node_modules', 'dist', 'build', '__pycache__', '.vscode', '.idea', 'coverage'}
IGNORE_EXTS = {
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', 
    '.zip', '.tar', '.gz', '.pdf', '.DS_Store', 
    '.pyc', '.lock', '.log', '.mp4', '.mp3'
}
IGNORE_FILES = {'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'}
OUTPUT_FILENAME = 'codebase_context.txt'

def generate_tree(dir_path, prefix=""):
    """Recursively generates a directory tree string."""
    tree_str = ""
    try:
        entries = sorted(os.listdir(dir_path))
    except PermissionError:
        return tree_str

    # Filter entries
    valid_entries = []
    for entry in entries:
        full_path = os.path.join(dir_path, entry)
        if os.path.isdir(full_path) and entry in IGNORE_DIRS:
            continue
        if os.path.isfile(full_path):
            _, ext = os.path.splitext(entry)
            if ext.lower() in IGNORE_EXTS or entry in IGNORE_FILES or entry == OUTPUT_FILENAME:
                continue
        valid_entries.append(entry)

    for i, entry in enumerate(valid_entries):
        is_last = i == (len(valid_entries) - 1)
        full_path = os.path.join(dir_path, entry)
        
        connector = "└── " if is_last else "├── "
        tree_str += f"{prefix}{connector}{entry}\n"
        
        if os.path.isdir(full_path):
            extension = "    " if is_last else "│   "
            tree_str += generate_tree(full_path, prefix + extension)
            
    return tree_str

def aggregate_codebase(root_dir):
    """Writes the tree and the contents of all valid files to a single text file."""
    output_path = os.path.join(root_dir, OUTPUT_FILENAME)
    
    with open(output_path, 'w', encoding='utf-8') as outfile:
        # 1. Write Directory Tree
        outfile.write("=" * 80 + "\n")
        outfile.write("DIRECTORY STRUCTURE\n")
        outfile.write("=" * 80 + "\n\n")
        outfile.write(os.path.basename(os.path.abspath(root_dir)) + "/\n")
        outfile.write(generate_tree(root_dir))
        outfile.write("\n\n")
        
        # 2. Write File Contents
        outfile.write("=" * 80 + "\n")
        outfile.write("FILE CONTENTS\n")
        outfile.write("=" * 80 + "\n\n")
        
        for root, dirs, files in os.walk(root_dir):
            # Modify dirs in-place to skip ignored directories
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
            
            for file in sorted(files):
                _, ext = os.path.splitext(file)
                if ext.lower() in IGNORE_EXTS or file in IGNORE_FILES or file == OUTPUT_FILENAME:
                    continue
                    
                file_path = os.path.join(root, file)
                rel_path = os.path.relpath(file_path, root_dir)
                
                outfile.write("-" * 80 + "\n")
                outfile.write(f"File: {rel_path}\n")
                outfile.write("-" * 80 + "\n")
                
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='replace') as infile:
                        outfile.write(infile.read())
                except Exception as e:
                    outfile.write(f"[Error reading file: {e}]\n")
                
                outfile.write("\n\n")
                
    print(f"Aggregation complete. Output saved to: {output_path}")

if __name__ == "__main__":
    target_directory = "." # Runs in the current directory
    aggregate_codebase(target_directory)