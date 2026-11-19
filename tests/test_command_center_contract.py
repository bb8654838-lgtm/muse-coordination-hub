from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CommandCenterContractTests(unittest.TestCase):
    def read(self, path: str) -> str:
        return (ROOT / path).read_text(encoding="utf-8")

    def test_spatial_command_center_artifacts_exist(self) -> None:
        required = [
            "apps/web/components/network/muse-mark.tsx",
            "apps/web/components/network/muse-node.tsx",
            "apps/web/components/network/network-canvas.tsx",
            "apps/web/components/network/transfer-layer.tsx",
            "apps/web/components/network/preview-transfer.tsx",
            "apps/web/components/hooks/use-workspace-realtime.ts",
            "apps/web/components/hooks/use-transfer-queue.ts",
            "apps/web/lib/realtime-visual-events.ts",
            "apps/web/components/dashboard/command-center-shell.tsx",
            "apps/web/components/dashboard/overview-view.tsx",
            "apps/web/components/dashboard/comms-view.tsx",
            "apps/web/components/dashboard/fleet-view.tsx",
            "apps/web/components/dashboard/pipeline-view.tsx",
            "apps/web/components/dashboard/vault-view.tsx",
        ]
        self.assertEqual([path for path in required if not (ROOT / path).is_file()], [])

    def test_geist_fonts_and_command_center_palette_are_wired(self) -> None:
        layout = self.read("apps/web/app/layout.tsx")
        styles = self.read("apps/web/app/globals.css").lower()
        self.assertIn('from "next/font/google"', layout)
        self.assertIn("Geist", layout)
        self.assertIn("Geist_Mono", layout)
        for token in ["#060910", "#0e1824", "#6ee7c7", "#60a5fa", "#a78bfa", "#fbbf24", "#fb7185"]:
            self.assertIn(token, styles)
        self.assertIn("perspective: 1200px", styles)
        self.assertIn("font-variant-numeric: tabular-nums", styles)
        self.assertIn("prefers-reduced-motion: reduce", styles)

    def test_realtime_visual_pipeline_and_queue_guards_are_explicit(self) -> None:
        hook = self.read("apps/web/components/hooks/use-workspace-realtime.ts")
        queue = self.read("apps/web/components/hooks/use-transfer-queue.ts")
        mapper = self.read("apps/web/lib/realtime-visual-events.ts")
        for table in ["agents", "channels", "messages", "tasks", "files", "heartbeats"]:
            self.assertIn(f'table: "{table}"', hook)
        self.assertIn("120", hook)
        self.assertIn("visualEventFromRealtime", hook)
        self.assertIn("MAX_ACTIVE_TRANSFERS = 12", queue)
        self.assertIn("seenIds", queue)
        for kind in ["chat", "file", "task", "done"]:
            self.assertIn(f'"{kind}"', mapper)

    def test_network_is_accessible_and_preview_is_local_only(self) -> None:
        canvas = self.read("apps/web/components/network/network-canvas.tsx")
        preview = self.read("apps/web/components/network/preview-transfer.tsx")
        transfer = self.read("apps/web/components/network/transfer-layer.tsx")
        for key in ["ArrowRight", "ArrowLeft", "Home", "End"]:
            self.assertIn(key, canvas)
        self.assertIn('aria-live="polite"', canvas)
        self.assertIn("Preview Animation", preview)
        self.assertNotIn("fetch(", preview)
        self.assertNotIn("supabase", preview.lower())
        self.assertIn("animateMotion", transfer)

    def test_command_views_keep_operational_surfaces_and_credits(self) -> None:
        dashboard = self.read("apps/web/components/owner-dashboard.tsx")
        shell = self.read("apps/web/components/dashboard/command-center-shell.tsx") if (ROOT / "apps/web/components/dashboard/command-center-shell.tsx").is_file() else ""
        combined = "\n".join(
            self.read(path)
            for path in [
                "apps/web/components/dashboard/overview-view.tsx",
                "apps/web/components/dashboard/comms-view.tsx",
                "apps/web/components/dashboard/fleet-view.tsx",
                "apps/web/components/dashboard/pipeline-view.tsx",
                "apps/web/components/dashboard/vault-view.tsx",
            ]
            if (ROOT / path).is_file()
        )
        all_ui = dashboard + shell + combined
        for surface in ["Overview", "Fleet", "Comms", "Pipeline", "Vault"]:
            self.assertIn(surface, all_ui)
        for contract in ["NOTE", "HANDOFF", "TASK", "ALERT", "DONE", "Create and assign task", "/api/owner/files/"]:
            self.assertIn(contract, all_ui)
        self.assertIn("<CommandCenterShell", dashboard)
        self.assertIn('import { DeveloperCredit }', shell)
        self.assertIn("<DeveloperCredit", shell)

    def test_five_category_operational_contracts_are_explicit(self) -> None:
        shell = self.read("apps/web/components/dashboard/command-center-shell.tsx")
        overview = self.read("apps/web/components/dashboard/overview-view.tsx")
        fleet = self.read("apps/web/components/dashboard/fleet-view.tsx")
        comms = self.read("apps/web/components/dashboard/comms-view.tsx")
        pipeline = self.read("apps/web/components/dashboard/pipeline-view.tsx")
        vault = self.read("apps/web/components/dashboard/vault-view.tsx")
        for label in ["Overview", "Fleet", "Comms", "Pipeline", "Vault"]:
            self.assertIn(label, shell)
        self.assertIn("NetworkCanvas", overview)
        self.assertIn("ActivityStream", overview)
        for token in ["agentLimit", "Invite Key", "Revoke", "heartbeat"]:
            self.assertIn(token, fleet)
        for token in ["general", "handoff", "alerts", "NOTE", "TASK", "HANDOFF", "ALERT", "DONE"]:
            self.assertIn(token, comms)
        for status in ["PENDING", "IN_PROGRESS", "BLOCKED", "ESCALATED", "DONE"]:
            self.assertIn(status, pipeline)
        for token in ["uploaded", "picked", "posted", "/api/owner/files/"]:
            self.assertIn(token, vault)

    def test_sentinel_stage_has_incremental_rigs_and_bounded_pools(self) -> None:
        sculpture = self.read("apps/web/components/network/muse-sculpture.ts")
        for token in ["class SentinelStage", "syncAgents", "InstancedMesh", "ShaderMaterial", "cancelPreview", "dispose", "ResizeObserver"]:
            self.assertIn(token, sculpture)
        canvas = self.read("apps/web/components/network/network-canvas.tsx")
        self.assertIn("stage.syncAgents", canvas)
        self.assertIn("stage.setReducedMotion", canvas)
        self.assertIn("stage.registerOverlays", canvas)

    def test_sentinel_camera_and_readable_event_surfaces(self) -> None:
        canvas = self.read("apps/web/components/network/network-canvas.tsx")
        for token in ["Overview", "Inspect", "Conversation", "Follow Transfer", "prefers-reduced-motion", "Event details"]:
            self.assertIn(token, canvas)
        self.assertNotIn("fetch(", canvas)
        self.assertNotIn("/api/", canvas)
        sculpture = self.read("apps/web/components/network/muse-sculpture.ts")
        self.assertIn("document.hidden", sculpture)
        self.assertIn("placeBubbles", sculpture)
        self.assertIn("classifyVisualEvent", sculpture)
        self.assertIn("resolveRoute", sculpture)

    def test_preview_choreography_is_explicit_and_cancellable(self) -> None:
        preview = self.read("apps/web/components/network/preview-transfer.tsx")
        for token in ["PREVIEW", "Simulate Live Chat", "Cancel", "clearTimeout", "previewRunId", "previewState"]:
            self.assertIn(token, preview)
        self.assertNotIn("fetch(", preview)
        self.assertNotIn("supabase", preview.lower())
        self.assertNotIn("/api/", preview)

    def test_web_dependency_contract_is_unchanged(self) -> None:
        package = json.loads(self.read("apps/web/package.json"))
        dependencies = dict(package["dependencies"])
        self.assertIn("three", dependencies)
        self.assertIn("@types/three", {**dependencies, **package.get("devDependencies", {})})
        # The approved renderer addition must not upgrade operational dependencies.
        dependencies.pop("three", None)
        dependencies.pop("@types/three", None)
        self.assertEqual(
            dependencies,
            {
                "@muse/skills": "1.0.0",  # Stage A internal metadata registry; external dependency pins stay unchanged.
                "@supabase/ssr": "^0.12.7",
                "@supabase/supabase-js": "2.119.1",
                "next": "16.4.6",
                "react": "19.3.1",
                "react-dom": "19.3.1",
            },
        )


class MuseSentinelBehavior(unittest.TestCase):
    """Exercise real TypeScript helpers, rather than only source-token checks."""

    _loader = r"""
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ts = require('typescript');
const cache = new Map();
function loadTS(relative) {
  const filename = path.resolve(relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  instance.require = function (name) {
    if (name === '@/lib/realtime-visual-events') return loadTS('apps/web/lib/realtime-visual-events.ts');
    return Module.prototype.require.call(this, name);
  };
  cache.set(filename, instance);
  instance._compile(compiled, filename);
  return instance.exports;
}
const scene = loadTS('apps/web/components/network/muse-sculpture.ts');
const adapter = loadTS('apps/web/lib/realtime-visual-events.ts');
const preview = loadTS('apps/web/components/network/preview-transfer.tsx');
const THREE = require('three');
const event = {id:'messages:fixture', kind:'chat', sourceId:'s0', targetId:'s1', label:'received text', createdAt:100, durationMs:1400};
"""

    def _run_typescript(self, assertions):
        import subprocess
        from pathlib import Path

        result = subprocess.run(
            ["node", "-e", self._loader + assertions],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SENTINEL_OK", result.stdout)

    def test_live_and_preview_semantics_and_full_text(self):
        self._run_typescript(r"""
const spoof = scene.classifyVisualEvent({...event, previewState:'typing'});
assert.equal(spoof.mode, 'live');
assert.equal(spoof.cue, 'chat');
for (const prefix of ['heartbeats:', 'agents:', 'channels:']) {
  const presence = scene.classifyVisualEvent({...event, id:prefix+'fixture'});
  assert.equal(presence.mode, 'live');
  assert.equal(presence.cue, 'presence');
}
assert.equal(scene.classifyVisualEvent({...event, replyToId:'real-parent'}).cue, 'reply');
assert.equal(scene.classifyVisualEvent({...event, id:'preview:run:0', previewState:'thinking'}).mode, 'preview');
assert.equal(scene.classifyVisualEvent({...event, id:'preview:run:0', previewState:'thinking'}).cue, 'thinking');
const ids = new Set(['s0','s1']);
const routed = scene.resolveRoute({...event, kind:'file', targetId:'unknown-task-id'}, ids);
assert.equal(routed.sourceId, 's0');
assert.equal(routed.targetId, 'muse-core');
assert.equal(routed.unresolved, true);
assert.equal(scene.resolveRoute({...event, sourceId:'unknown-agent'}, ids).sourceId, 'muse-core');
const full = 'Original received body\n' + 'long text '.repeat(80);
const mapped = adapter.visualEventFromRealtime('messages', {eventType:'INSERT', new:{id:'body-fixture', sender_id:'s0', mentions:['s1'], body:full, message_type:'NOTE', reply_to:'parent-fixture'}, old:{}});
assert.equal(mapped.detail, full);
assert.equal(mapped.replyToId, 'parent-fixture');
assert.ok(mapped.label.length < full.length);
assert.equal(scene.classifyVisualEvent(mapped).cue, 'reply');
console.log('SENTINEL_OK semantics: real presence, authentic replies, spoof resistance, HQ routing, verbatim text');
""")

    def test_camera_fit_contains_ten_articulated_rigs(self):
        self._run_typescript(r"""
const ids = Array.from({length:10},(_,i)=>'s'+i);
const fov = scene.STAGE_FOV * Math.PI / 180;
assert.ok(fov > 0 && fov < Math.PI / 2);
let checks=0;
for (const aspect of [280/520, 312/520, 360/520, 1, 1366/560]) {
  const layout = scene.layoutAgentPositions(ids, aspect);
  assert.equal(layout.size, 10);
  const points = [...layout.values()].map(p=>new THREE.Vector3(p.x,p.y,p.z));
  assert.equal(new Set(points.map(p=>p.toArray().join(','))).size, 10);
  points.push(new THREE.Vector3(0,0,0));
  const bounds = new THREE.Box3().setFromPoints(points).expandByScalar(1.25);
  const center = bounds.getCenter(new THREE.Vector3());
  for (const azimuth of [-2.1,0,1.7]) for (const elevation of [0.15,0.48,0.95]) {
    const distance = scene.computeFitDistance(bounds, aspect, azimuth, elevation);
    assert.ok(Number.isFinite(distance) && distance > 0);
    const direction = new THREE.Vector3(Math.sin(azimuth)*Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth)*Math.cos(elevation));
    const camera = new THREE.PerspectiveCamera(scene.STAGE_FOV, aspect, 0.1, 300);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.lookAt(center); camera.updateMatrixWorld();
    for (const x of [bounds.min.x,bounds.max.x]) for (const y of [bounds.min.y,bounds.max.y]) for (const z of [bounds.min.z,bounds.max.z]) {
      const projected = new THREE.Vector3(x,y,z).project(camera);
      assert.ok(Math.abs(projected.x) <= 1.001 && Math.abs(projected.y) <= 1.001, `fit clipped aspect=${aspect} az=${azimuth} elev=${elevation}: ${projected.toArray()}`);
      assert.ok(projected.z > -1 && projected.z < 1);
      checks++;
    }
  }
}
assert.ok(scene.POOL_CAPACITY >= 1 && scene.POOL_CAPACITY <= 32);
console.log('SENTINEL_OK camera bounds checks='+checks);
""")

    def test_mobile_bubbles_clamp_and_never_overlap(self):
        self._run_typescript(r"""
const items = Array.from({length:4},(_,i)=>({id:'b'+i,x:180,y:160,width:196,height:104}));
const placed = scene.placeBubbles(items,{width:360,height:520},2);
const visible = placed.filter(p=>!p.hidden);
assert.equal(visible.length,2);
for (const p of visible) {
  const size=items.find(item=>item.id===p.id);
  assert.ok(p.x >= 0 && p.y >= 0);
  assert.ok(p.x+size.width <= 360 && p.y+size.height <= 520);
}
const a=visible[0], b=visible[1];
assert.ok(a.x+196 <= b.x || b.x+196 <= a.x || a.y+104 <= b.y || b.y+104 <= a.y);
for (const size of [{width:220,height:190},{width:1024,height:640}]) {
  const edge = scene.placeBubbles([{id:'left',x:-999,y:-999,width:196,height:104},{id:'right',x:9999,y:9999,width:196,height:104}],size,2);
  for (const p of edge.filter(p=>!p.hidden)) assert.ok(p.x>=0 && p.y>=0 && p.x+196<=size.width && p.y+104<=size.height);
}
console.log('SENTINEL_OK clamped, de-overlapped mobile bubbles');
""")

    def test_preview_steps_are_separate_local_events(self):
        self._run_typescript(r"""
const agents=[{id:'s0',status:'online',display_name:'Fixture A'},{id:'s1',status:'idle',display_name:'Fixture B'},{id:'blocked',status:'revoked',display_name:'Revoked'}];
const steps=preview.buildPreviewSteps(agents,'fixture-run',1000).map(({delayMs,event})=>({...event,delayMs}));
assert.ok(steps.length>=6);
assert.equal(new Set(steps.map(s=>s.id)).size,steps.length);
for (let i=0;i<steps.length;i++) {
  const step=steps[i];
  assert.ok(step.id.startsWith('preview:fixture-run:'));
  assert.equal(step.previewRunId,'fixture-run');
  assert.equal(step.createdAt,1000+step.delayMs);
  assert.notEqual(step.sourceId,'blocked'); assert.notEqual(step.targetId,'blocked');
  assert.equal(scene.classifyVisualEvent(step).mode,'preview');
  if(i) assert.ok(step.delayMs>=steps[i-1].delayMs);
}
for(const cue of ['thinking','typing','reply']) assert.ok(steps.some(step=>step.previewState===cue));
assert.ok(steps.some(step=>step.kind==='file'));
const solo=preview.buildPreviewSteps([], 'solo', 1000).map(({event})=>event);
assert.ok(solo.every(step=>step.sourceId==='muse-core' && step.targetId==='muse-core'));
console.log('SENTINEL_OK cancellable preview IDs and HQ-only empty fallback');
""")


if __name__ == "__main__":
    unittest.main()
