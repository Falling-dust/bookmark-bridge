"""Create a ready-to-extract, dependency-free unpacked extension ZIP."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
output = root / 'release' / f'bookmark-bridge-{manifest["version"]}.zip'
output.parent.mkdir(exist_ok=True)
files = ['manifest.json', 'manager.html', 'styles.css', 'app.js', 'background.js', 'README.md']
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, f'bookmark-bridge/{name}')
    for directory in ('lib', 'icons', 'examples', 'docs'):
        for path in sorted((root / directory).rglob('*')):
            if path.is_file():
                archive.write(path, f'bookmark-bridge/{path.relative_to(root).as_posix()}')
print(output)
print(f'{output.stat().st_size:,} bytes')
