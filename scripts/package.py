"""Package runtime files and the installation guide as an unpacked extension."""
import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from time import sleep
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = ('manifest.json', 'manager.html', 'styles.css', 'app.js', 'background.js')


def package_files(root=ROOT):
    """Return the release version and explicit source/archive path pairs."""
    root = root.resolve()
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    if manifest['version'] != package['version']:
        raise ValueError('manifest.json and package.json must have the same version.')

    files = [(root / name, name) for name in RUNTIME_FILES]
    files.append((root / 'docs' / 'INSTALL.md', 'README.md'))
    for directory in ('lib', 'ui'):
        files.extend((path, path.relative_to(root).as_posix())
                     for path in sorted((root / directory).rglob('*.js')) if path.is_file())
    files.extend((path, path.relative_to(root).as_posix())
                 for path in sorted((root / 'icons').iterdir())
                 if path.is_file() and path.suffix in ('.png', '.svg'))
    for path, _ in files:
        if not path.is_file() or not path.resolve().is_relative_to(root):
            raise ValueError(f'Missing or external package file: {path}')
    return manifest['version'], files


def build_package(root=ROOT):
    version, files = package_files(root)
    output = root / 'release' / f'bookmark-bridge-{version}.zip'
    output.parent.mkdir(exist_ok=True)
    temporary_file = NamedTemporaryFile(dir=output.parent, prefix=output.stem + '-', suffix='.tmp', delete=False)
    temporary = Path(temporary_file.name)
    try:
        with temporary_file, ZipFile(temporary_file, 'w', ZIP_DEFLATED) as archive:
            for source, name in files:
                archive.write(source, f'bookmark-bridge/{name}')
        # Windows may briefly lock the destination while another build replaces it.
        for attempt in range(5):
            try:
                temporary.replace(output)
                break
            except PermissionError as error:
                if getattr(error, 'winerror', None) not in (5, 32, 33) or attempt == 4:
                    raise
                sleep(0.05 * (attempt + 1))
    finally:
        temporary.unlink(missing_ok=True)
    return output


if __name__ == '__main__':
    archive = build_package()
    print(archive)
    print(f'{archive.stat().st_size:,} bytes')
