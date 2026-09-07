import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function expandPlan(plan) {
  const nodes = [];
  for (const task of plan.packages ?? []) {
    const upstream = (task.dependencies ?? []).map(id => `${id}.V`);
    if (task.kind === 'implementation') nodes.push({
      id: `${task.id}.R`, package: task.id, role: 'reference',
      dependencies: task.id === 'P00' ? [] : ['P00.V'],
    });
    nodes.push({ id: `${task.id}.I`, package: task.id, role: 'implementation-or-gate',
      dependencies: [...upstream, ...(task.kind === 'implementation' ? [`${task.id}.R`] : [])] });
    nodes.push({ id: `${task.id}.V`, package: task.id, role: 'independent-review',
      dependencies: [`${task.id}.I`, ...(['P00', 'P01'].includes(task.id) ? [] : ['P01.V'])] });
  }
  return nodes;
}

export function validatePlan(plan, canonicalParents) {
  const errors = [];
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.packages) || !plan.packages.length) return ['Invalid plan schema'];
  if (!['proposed-awaiting-user-authorization', 'approved-for-execution'].includes(plan.status)
    || plan.releaseExcluded !== true) errors.push('Planning authority or release boundary changed');
  if (!Array.isArray(plan.requiredParents) || !plan.requiredParents.length
    || new Set(plan.requiredParents).size !== plan.requiredParents.length) return ['Invalid required parent inventory'];
  if (canonicalParents && JSON.stringify([...plan.requiredParents].sort()) !== JSON.stringify([...canonicalParents].sort())) {
    errors.push('Required parent families differ from canonical migration inventory');
  }
  const ids = new Set();
  for (const task of plan.packages) {
    if (!task || typeof task !== 'object') { errors.push('Invalid task object'); continue; }
    if (!/^[A-Z][0-9]{2}$/.test(task.id) || ids.has(task.id)) errors.push(`Invalid/duplicate package: ${task.id}`);
    ids.add(task.id);
    for (const key of ['title', 'planning_scope', 'acceptance']) if (typeof task[key] !== 'string' || !task[key].trim()) errors.push(`Missing ${key}: ${task.id}`);
    if (!['implementation', 'gate'].includes(task.kind) || task.status !== 'proposed') errors.push(`Invalid package state: ${task.id}`);
    if (!Array.isArray(task.parents) || !task.parents.length || task.parents.some(id => typeof id !== 'string')) errors.push(`Missing parent: ${task.id}`);
    if (!Array.isArray(task.dependencies) || task.dependencies.some(id => typeof id !== 'string')
      || new Set(task.dependencies).size !== task.dependencies.length) errors.push(`Invalid dependencies: ${task.id}`);
  }
  if (errors.length) return errors;
  for (const task of plan.packages) for (const dep of task.dependencies) if (!ids.has(dep)) errors.push(`Unknown dependency ${dep}: ${task.id}`);
  const required = new Set(plan.requiredParents);
  for (const task of plan.packages) for (const parent of task.parents) if (!required.has(parent)) errors.push(`Unknown parent ${parent}`);
  for (const parent of required) if (!plan.packages.some(task => task.parents.includes(parent))) errors.push(`Unplanned parent ${parent}`);
  const nodes = expandPlan(plan), byId = new Map(nodes.map(node => [node.id, node]));
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { errors.push(`Dependency cycle: ${id}`); return; }
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) { errors.push(`Unknown expanded dependency ${id}`); return; }
    visiting.add(id);
    node.dependencies.forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  nodes.forEach(node => visit(node.id));
  const reachable = new Set();
  function ancestors(id) {
    if (reachable.has(id)) return;
    reachable.add(id); byId.get(id)?.dependencies.forEach(ancestors);
  }
  ancestors('G13.V');
  for (const node of nodes) if (!reachable.has(node.id)) errors.push(`Node does not contribute to final conversion: ${node.id}`);
  return [...new Set(errors)];
}

export function renderCatalog(plan) {
  const nodes = expandPlan(plan);
  let text = '# Remaining migration task catalog\n\n';
  text += `${plan.status === 'approved-for-execution' ? 'Approved for execution' : 'Proposed'} from \`${plan.baseline}\`: ${plan.packages.length} work packages, ${nodes.length} separately assignable agent tasks.\n\n`;
  text += 'Generated from [plan.json](plan.json). Read [execution rules](../remaining-migration-plan.md) before dispatch.\n';
  text += 'Every row requires the common acceptance gate as well as its specific criteria. Planning scopes are not write authorization; exact allowed_files must be frozen before implementation.\n\n';
  text += 'For implementation packages: **R** freezes/reuses independent reference evidence and the file/test manifest; **I** implements after every prerequisite V and its own R; **V** is independent review of the final revision. Gate packages have I and V only.\n\n';
  text += 'References can be prepared ahead of implementation dependencies, using existing behavior and inert interfaces; interface changes reopen them. Downstream implementation waits for prerequisite V. Gate pass alone never grants live release authority.\n\n';
  for (const prefix of [...new Set(plan.packages.map(task => task.id[0]))]) {
    text += `## ${prefix} task group\n\n`;
    for (const task of plan.packages.filter(item => item.id[0] === prefix)) {
      text += `### ${task.id} — ${task.title}\n\n`;
      text += `- Agent tasks: ${task.kind === 'implementation' ? `${task.id}.R → ` : ''}${task.id}.I → ${task.id}.V.\n`;
      text += `- Implementation prerequisites: ${task.dependencies.length ? task.dependencies.map(dep => dep + '.V').join(', ') : 'none; approval and dispatch manifest still required'}.\n`;
      text += `- Parent gates: ${task.parents.join(', ')}.\n- Planning ownership: ${task.planning_scope}.\n- Acceptance: ${task.acceptance}\n\n`;
    }
  }
  return text.trimEnd() + '\n';
}

export function renderGraph(plan, expanded = false) {
  const rows = expanded ? expandPlan(plan) : plan.packages;
  let result = 'flowchart TD\n';
  for (const row of rows) {
    const id = row.id.replaceAll('.', '_');
    const label = expanded ? `${row.id}: ${row.role}` : `${row.id}: ${row.title}`;
    result += `  ${id}["${label.replaceAll('"', "'")}"]\n`;
    for (const dep of row.dependencies) result += `  ${dep.replaceAll('.', '_')} --> ${id}\n`;
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const directory = resolve(root, 'docs/migration/remaining');
  const plan = JSON.parse(await readFile(resolve(directory, 'plan.json'), 'utf8'));
  const canonical = JSON.parse(await readFile(resolve(root, 'config/migration/nodes.json'), 'utf8'));
  const errors = validatePlan(plan, canonical.nodes.map(node => node.id).filter(id => id !== 'RELEASE'));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else {
    const outputs = { 'task-catalog.md': renderCatalog(plan), 'packages.mmd': renderGraph(plan),
      'agent-tasks.mmd': renderGraph(plan, true), 'agent-tasks.json': JSON.stringify(expandPlan(plan), null, 2) + '\n',
      'dag.md': '# Complete package DAG\n\nEach package expands into the independent assignments in the [task catalog](task-catalog.md).\n\n```mermaid\n' + renderGraph(plan) + '```\n',
      'agent-dag.md': '# Complete agent-assignment DAG\n\nR = reference/manifest, I = implementation or gate, V = independent review. See [execution rules](../remaining-migration-plan.md).\n\n```mermaid\n' + renderGraph(plan, true) + '```\n' };
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => arg !== '--write')) throw new Error('Usage: node tools/migration/check-remaining-plan.mjs [--write]');
    for (const [name, content] of Object.entries(outputs)) {
      const path = resolve(directory, name);
      if (args[0] === '--write') await writeFile(path, content);
      else if (await readFile(path, 'utf8') !== content) throw new Error(`Stale rendered plan: ${name}`);
    }
    console.log(JSON.stringify({ status: `valid-${plan.status}`, packages: plan.packages.length,
      agentTasks: expandPlan(plan).length, parentFamilies: plan.requiredParents.length, acceptance: 'not-executed' }));
  }
}
