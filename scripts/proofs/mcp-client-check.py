#!/usr/bin/env python3
"""Drives the notebook's real MCP client with a fake Streamable HTTP server."""
import io, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, '..', '..', 'android', 'app', 'src', 'main', 'assets', 'aether-notebook-template.json')
src = json.load(open(TPL))['cells'][4]['source']
code = src[src.index('def _mcp_request'):src.index('def agent_stream')]

passed = failed = 0
def check(name, condition, detail=''):
    global passed, failed
    print(('  PASS  ' if condition else '  FAIL  ') + name + ('  [' + str(detail) + ']' if detail else ''))
    passed += bool(condition); failed += not condition

calls = []
class Request:
    def __init__(self, url, data, method):
        self.url, self.data, self.method, self.headers = url, data, method, {}
    def add_header(self, key, value): self.headers[key.lower()] = value
class Response:
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit):
        if self.value.get('sse'):
            body = 'event: message\ndata: ' + json.dumps(self.value['body']) + '\n\n'
        else: body = json.dumps(self.value['body'])
        return io.BytesIO(body.encode()).read(limit)
class Urllib:
    class request:
        Request = Request
        @staticmethod
        def urlopen(request, timeout):
            payload = json.loads(request.data)
            calls.append((request, payload))
            method = payload['method']
            if method == 'initialize': body = {'jsonrpc':'2.0','id':payload['id'],'result':{'protocolVersion':'2025-03-26','capabilities':{'tools':{}}}}
            elif method == 'tools/list':
                body = {'jsonrpc':'2.0','id':payload['id'],'result':{'tools':[
                    {'name':'search_issues','description':'Search issues','inputSchema':{'type':'object','properties':{'query':{'type':'string'}}}},
                    {'name':'create_issue','description':'Create an issue','inputSchema':{'type':'object','properties':{'owner':{'type':'string'},'repo':{'type':'string'},'title':{'type':'string'}}}},
                    {'name':'run_workflow','description':'Run a workflow','inputSchema':{'type':'object','properties':{}}}
                ]}}
            else: body = {'jsonrpc':'2.0','id':payload['id'],'result':{'content':[{'type':'text','text':'real tool result'}]}}
            return Response({'body':body, 'sse':method == 'tools/call'})

ns = {'json':json, 're':__import__('re'), 'urllib':Urllib()}
exec(code, ns)
server = {'name':'GitHub','url':'https://mcp.example/mcp','token':'secret-not-logged','enabled':True,'read':True,'write':False,'execute':False,'repository':'owner/project'}
schemas, executors, errors = ns['_mcp_bind']([server])
names = [s['function']['name'] for s in schemas]
check('initialize and tools/list produce a real schema', len(calls) == 2 and calls[0][1]['method'] == 'initialize' and calls[1][1]['method'] == 'tools/list', len(calls))
check('read grant exposes search but not write/execute', len(names) == 1 and names[0].endswith('__search_issues'), names)
result = executors[names[0]](query='aether')
check('tools/call executes and parses an SSE result', 'real tool result' in result, result)
check('MCP uses JSON-RPC tools/call with original remote name', calls[-1][1]['method'] == 'tools/call' and calls[-1][1]['params']['name'] == 'search_issues')
check('authorization is a header, never tool output', calls[-1][0].headers.get('authorization','').startswith('Bearer ') and 'secret-not-logged' not in result)
check('MCP protocol and dual accept headers are sent', calls[-1][0].headers.get('mcp-protocol-version') == '2025-03-26' and 'text/event-stream' in calls[-1][0].headers.get('accept',''))

calls[:] = []
server['write'] = True
schemas, executors, errors = ns['_mcp_bind']([server])
create = [name for name in executors if name.endswith('__create_issue')][0]
executors[create](owner='attacker', repo='other', title='Test')
params = calls[-1][1]['params']['arguments']
check('write grant enables create and repository scope is enforced', params.get('owner') == 'owner' and params.get('repo') == 'project', params)
check('execute remains denied without its grant', not any(name.endswith('__run_workflow') for name in executors))

calls[:] = []
server['execute'] = True
schemas, executors, errors = ns['_mcp_bind']([server])
check('execute grant enables workflow independently', any(name.endswith('__run_workflow') for name in executors))

calls[:] = []
server['enabled'] = False
schemas, executors, errors = ns['_mcp_bind']([server])
check('disabled server performs no network and exposes no tools', not calls and not schemas and not executors)

print('\nMCP CLIENT PROOF  %d passed, %d failed' % (passed, failed))
raise SystemExit(1 if failed else 0)
