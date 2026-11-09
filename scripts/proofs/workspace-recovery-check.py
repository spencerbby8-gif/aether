#!/usr/bin/env python3
"""Real filesystem proof of Workspace confinement and one-step rollback."""
import json, os, re, tempfile, zipfile
HERE=os.path.dirname(os.path.abspath(__file__))
TPL=os.path.join(HERE,'..','..','android','app','src','main','assets','aether-notebook-template.json')
src=json.load(open(TPL))['cells'][4]['source']
code=src[src.index('def _workspace_path'):src.index('class H(BaseHTTPRequestHandler):')]
passed=failed=0
def check(name,ok,detail=''):
 global passed,failed
 print(('  PASS  ' if ok else '  FAIL  ')+name+'  ['+str(detail)+']');passed+=bool(ok);failed+=not ok
base=tempfile.mkdtemp(prefix='aether-workspace-recovery-')
ns={'os':os,'re':re,'GEN_DIR':os.path.join(base,'generated'),'_CURRENT':{},'_SESSION_RE':re.compile(r'[A-Za-z0-9_-]{1,64}'),'_session_dir':lambda s:os.path.join(base,'sessions',s)}
exec(code,ns)
os.makedirs(ns['_session_dir']('chat'),exist_ok=True)
root,target=ns['_workspace_path']('chat','folder/file.txt')
check('nested file resolves inside session',target.startswith(os.path.realpath(ns['_session_dir']('chat'))+os.sep),target)
for bad in ('../outside','/absolute','a/../../outside'):
 try: ns['_workspace_path']('chat',bad); escaped=True
 except ValueError: escaped=False
 check('path traversal refused: '+bad,escaped is False)
try: ns['_workspace_path']('../bad','');bad_session=True
except ValueError: bad_session=False
check('invalid session refused',bad_session is False)

root,target=ns['_workspace_path']('chat','notes.txt');os.makedirs(root,exist_ok=True)
with open(target,'w') as f:f.write('known good')
ns['_workspace_save_rollback']('chat',root)
with open(target,'w') as f:f.write('damaged edit')
with open(os.path.join(root,'extra.txt'),'w') as f:f.write('extra')
check('rollback checkpoint exists independently of current edits',os.path.isfile(os.path.join(ns['GEN_DIR'],'rollback-chat.zip')))
count=ns['_workspace_restore_rollback']('chat')
check('restore returns real file count',count==1,count)
check('known-good content is restored',open(target).read()=='known good',open(target).read())
check('file added after checkpoint is removed',not os.path.exists(os.path.join(root,'extra.txt')))
with zipfile.ZipFile(os.path.join(ns['GEN_DIR'],'rollback-chat.zip')) as z:check('checkpoint archive contains expected path',z.namelist()==['notes.txt'],z.namelist())
try: ns['_workspace_restore_rollback']('missing');missing=True
except ValueError:missing=False
check('missing checkpoint reports failure instead of inventing success',missing is False)
print('\nWORKSPACE RECOVERY PROOF  %d passed, %d failed'%(passed,failed))
raise SystemExit(1 if failed else 0)
