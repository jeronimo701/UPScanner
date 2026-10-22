"""Build a fresh portable executable without copying business/user records."""
from pathlib import Path
import argparse,subprocess,sys,shutil
ROOT=Path(__file__).resolve().parent
p=argparse.ArgumentParser()
p.add_argument('--output',required=True,type=Path)
a=p.parse_args();out=a.output.resolve()
if out.exists():raise SystemExit('Output exists; select a new directory. Nothing is deleted.')
if out==ROOT or ROOT in out.parents and 'work' not in out.relative_to(ROOT).parts:raise SystemExit('Select a separate build destination.')
out.mkdir(parents=True)
work=ROOT/'work/pyinstaller'
args=[sys.executable,'-m','PyInstaller','--noconfirm','--onefile','--windowed','--noupx','--distpath',str(out),'--workpath',str(work/'cache'),'--specpath',str(work),'--hidden-import','pystray._win32','--log-level','WARN','--add-data',str(ROOT/'publication-notices')+';publication-notices']
args+=['--name','UPScanner','--icon',str(ROOT/'assets/up_scanner_duck.ico'),'--hidden-import','xlrd','--add-data',str(ROOT/'up_scanner/web')+';up_scanner/web','--add-data',str(ROOT/'assets/up_scanner_duck.png')+';assets']
for module in ['tkinter','matplotlib','pandas','PySide6','PyQt6','IPython','pytest']:args+=['--exclude-module',module]
args.append(str(ROOT/'main.py'))
subprocess.run(args,check=True)
for directory in ['Acts/new','Acts/old','Acts/exports','data']:(out/directory).mkdir(parents=True,exist_ok=True)
for filename in ['LICENSE.txt','LICENSE-SCOPE.md','THIRD-PARTY.md','SOURCES.json']:
    shutil.copy2(ROOT/filename,out/filename)
shutil.copytree(ROOT/'publication-notices',out/'publication-notices')
print('Built portable folder:',out)
