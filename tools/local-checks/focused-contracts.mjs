import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const CONTRACT_PATH = 'docs/migration/evidence/p03/retry2/reference-consumers.json';
export const SOURCE_SUFFIX = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const ordered = values => [...new Set(values)].sort();
export const safePath = value => typeof value === 'string' && value.length > 0
  && !isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const paths = value => Array.isArray(value) && value.every(safePath) && new Set(value).size === value.length;
const RULE_IDS = ['local-numeric', 'local-typed-json', 'local-store-validation', 'local-resume-view',
  'local-raw-reference', 'local-profile-reference'];
export const NATIVE_ROOTS = [
  'tests_js/posix_flock.test.mjs', 'tests_js/exclusive_file_lock_ts.test.mjs',
  'tests_js/exclusive_file_lock_fault_ts.test.mjs', 'tests_js/jsonl_lock_integration.test.mjs',
  'tests_js/heavy_run_lease_reference.test.mjs', 'tests_js/posix_timestamps.test.mjs',
];

// Never follow a tracked symlink, including one in a parent component.
export async function readRegular(root, path, maxBytes = 8 * 1024 * 1024) {
  if (!safePath(path)) throw new Error(`Unsafe repository path: ${path}`);
  const base = await realpath(root);
  let current = base;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || (index < parts.length - 1 ? !metadata.isDirectory() : !metadata.isFile())) {
      throw new Error(`Nonregular repository path: ${path}`);
    }
    if (index === parts.length - 1 && metadata.size > maxBytes) throw new Error(`Oversized graph input: ${path}`);
  }
  if (relative(base, resolve(current)).startsWith('..')) throw new Error(`External repository path: ${path}`);
  const bytes = await readFile(current);
  if (bytes.length > maxBytes) throw new Error(`Oversized graph input: ${path}`);
  return bytes;
}

export async function loadFocusedContracts(root) {
  const bytes = await readRegular(root, CONTRACT_PATH);
  const value = JSON.parse(bytes);
  if (value.schemaVersion !== 1 || !Array.isArray(value.rules)
    || JSON.stringify(ordered(value.rules.map(rule => rule.id))) !== JSON.stringify(ordered(RULE_IDS))) {
    throw new Error('Invalid six-rule focused contract');
  }
  const required = [];
  const optional = ['lightTests', 'heavyTests', 'runtimePaths', 'sharedContractPaths', 'sharedContractAdditionalHeavyTests', 'sharedContractAdditionalLightTests',
    'referencePaths', 'referenceTests', 'testInputPaths', 'testInputCompanions'];
  for (const rule of value.rules) {
    for (const field of required) if (!paths(rule[field])) throw new Error(`Invalid ${rule.id}.${field}`);
    for (const field of optional) if (rule[field] !== undefined && !paths(rule[field])) {
      throw new Error(`Invalid ${rule.id}.${field}`);
    }
  }
  const inventory = value.inventory;
  if (!inventory || !Array.isArray(inventory.candidates) || !Array.isArray(inventory.edges)
    || !Array.isArray(inventory.calls) || !Array.isArray(inventory.urls)
    || inventory.candidateCount !== inventory.candidates.length
    || inventory.candidateDigest !== digest(JSON.stringify(inventory.candidates))) throw new Error('Invalid graph census');
  if (!paths(inventory.candidates.map(item => item.path))
    || inventory.candidates.some(item => !SOURCE_SUFFIX.test(item.path) || !hash(item.sha256))) {
    throw new Error('Invalid graph candidate identity');
  }
  for (const edge of inventory.edges) if (!safePath(edge.from) || !safePath(edge.to) || typeof edge.kind !== 'string') {
    throw new Error('Invalid reviewed edge');
  }
  for (const row of [...inventory.calls, ...inventory.urls]) if (!safePath(row.path)
    || !hash(row.sha256) || typeof row.expression !== 'string' || digest(row.expression) !== row.sha256) {
    throw new Error('Invalid reviewed callsite');
  }
  if (JSON.stringify(ordered(value.nativeFallback?.testRoots ?? [])) !== JSON.stringify(ordered(NATIVE_ROOTS))
    || value.nativeFallback.reuseAllowed !== false) throw new Error('Invalid native obligation');
  return { value, fingerprint: digest(bytes), candidates: new Map(inventory.candidates.map(item => [item.path, item.sha256])) };
}

// Independently reviewed finite call/caller recipes. Containing-byte changes invalidate aliases too.
export const PROCESS_RECIPES = [
  {
    identity: ["tests_js/artifact_copy_metadata_reference.test.mjs","f67b9c7b9f3ef784acc505d0660427c757ae33afc2bef7f47e845653a2aa00cd"],
    callHashes: ["2ef9dee1db6171ebd1b6c274df0273dca06ac69685303001140fe1d06c6552e4","5cf2f0b2b69e88cabe70cbf240ead79f40e73ba132f254a50050bafb3ec1bc75","6f13fb34f922e1f6763c00cd27fdae987c94de1ed35ef1a21b366234f446d9da"],
    python: true,
    repositoryTargets: ["scripts/smoke/artifacts.py","tools/contracts/artifact-copy-metadata/reference.py","tools/contracts/artifact-copy-metadata/support.py"],
  },
  {
    identity: ["tests_js/artifact_copy_order_reference.test.mjs","4f9c926ad9dd0a429df5b44f431f5f5aa7b7715d42cd4bd7f91dd8c2e4eac989"],
    callHashes: ["5cf2f0b2b69e88cabe70cbf240ead79f40e73ba132f254a50050bafb3ec1bc75","865cdbe0bf8270688817f3b4e20a887abb5c82fbb56b4554a0b456cc8841136f","e7e9c3d3905539a9162f64a64a32f7286ae6f36f53575acaf225cae9735349c9"],
    python: true,
    repositoryTargets: ["scripts/smoke/artifacts.py","tools/contracts/artifact-copy-order/reference.py","tools/contracts/artifact-copy-order/support.py"],
  },
  {
    identity: ["tests_js/artifact_data_copy_reference.test.mjs","d2b95a96eb57f8e4000b24467462ec1cae146d9aa6c600794f2719e1581a60f5"],
    callHashes: ["14d5a736d184f0d87f9e87e470d0e579cf7bc7a42a6f97976916edc0791bfe5f","dc2943a48b7dc4bc60305207e1d735b6ba95bfe600dbad0e13fffce4159b638d"],
    python: true,
    repositoryTargets: ["scripts/smoke/artifacts.py","tools/contracts/artifact-data-copy/reference.py","tools/contracts/artifact-data-copy/support.py"],
  },
  {
    identity: ["tests_js/atomic_write_json_reference.test.mjs","f022146fca2bf619338cd6113b788c728fc387bcba09f94022f954432a6d9d57"],
    callHashes: ["02221983f963c4a9119b50e3998b6910e728dd23855b52c7e4e1ade30d91359c","0f45c132596674a9180c425591811d13f72081621cbc2d1f61e4aa0418f03ea3"],
    python: true,
    repositoryTargets: ["tools/contracts/atomic-write-json/reference.py"],
  },
  {
    identity: ["tests_js/atomic_write_json_ts.test.mjs","0e7d3095e9745fa703a5d77d389f296a34ae0cec9cb3296693b24dfafb56e473"],
    callHashes: ["96a0ce4296e24f95d6d98dddb3d11fe71df27a4d89e7e3ca33ffcb124287c16e","d891f71c9b14bcafacfcee13c107b2d011a4c977f659f2be576b1d430f86f128","f0754ab9378f1f87e6009df971dde8539456620c4e6533806196341fc2728c93"],
    python: true,
    repositoryTargets: ["scripts/job_apply_store/io.py","tools/contracts/atomic-write-json/reference.py"],
  },
  {
    identity: ["tests_js/codepoint_json_reference.test.mjs","9939a313ef84018e2dd742c8994ae34d3e1f203201bfdf81a044538cbe5aff3a"],
    callHashes: ["8e6967b260a58fe709b6f71c8c71da4483216cfce3159688ffd2c40403ecfa54"],
    python: true,
    repositoryTargets: ["tools/contracts/codepoint-json/reference.py"],
  },
  {
    identity: ["tests_js/data_copy_ts.test.mjs","a68f165cc179280cffc3574589cff744215af07adf64a69a953dcc48eae63447"],
    callHashes: ["14d5a736d184f0d87f9e87e470d0e579cf7bc7a42a6f97976916edc0791bfe5f","3fea3428867fdb010367352746beabe04ad4e0fbba1aada9b6d336f8bd708e51"],
    python: true,
    repositoryTargets: ["tests_js/data_copy_support.mjs","tools/contracts/artifact-data-copy/reference.py"],
    requiredSourceBindings: [{"path":"tests_js/data_copy_support.mjs","sha256":"29a48489e94087310b6d0c55493ef8ea0d41d3d6e0e8fdcf44ac9462f8febbe4"}],
  },
  {
    identity: ["tests_js/exclusive_file_lock_reference.test.mjs","01463b5dd67203daa7ec5cdd281be22e03e1d1ea97cd4eb49e0f06cb58de26dc"],
    callHashes: ["381943d1da5dcd9699e246cb123de3065f9676e771c67e1846d2d47dd433411f","6c79cc409711d103fe8d8f01399e905c148db9ffed617978750816afb93c70d3","7f12ddca642a30b58175d21ccd434fdf13296c26a58afec47a232c2e0f99c297"],
    python: true,
    repositoryTargets: ["scripts/job_apply_store/io.py","tools/contracts/exclusive-file-lock/reference.py"],
  },
  {
    identity: ["tests_js/filesystem_error_ts.test.mjs","a4928009a0e01feea2e7f1cba4513d521a96e9963bc909ca999600319b8f4783"],
    callHashes: ["ab17846569b0c8aefd717772413422f00b13e446b39f473ad847a18eda9feb9c"],
    python: true,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/history_read_idempotency_reference.test.mjs","eb3ecfd07c1b279e16f93be876d71dad73c33e0bcad04838a5777a3467cfc238"],
    callHashes: ["3e54880aa5850e8afee8839600171ec3a612e91a681d4ba4735c310e4f1804ee","e820404a5eaa3355a662ee147e0a3eec10720647d415f24122145f2b30aad4ed"],
    python: true,
    repositoryTargets: ["scripts/job_apply_store/domains/coordinator/persistence.py","scripts/job_apply_store/domains/sessions/history.py","scripts/job_apply_store/io.py","scripts/job_apply_store/normalization.py","scripts/job_apply_store/validation/sessions.py","tools/contracts/history-read-idempotency/reference.py","tools/contracts/history-read-idempotency/support.py"],
  },
  {
    identity: ["tests_js/http_json_bytes_reference.test.mjs","4993d21753c27d86d4a0775c3950dd373cd14c1ebc8f7a881e83eb07be6dc8df"],
    callHashes: ["acddb4f2fc4955c7aeb10f5d59e2f4b2d3c4f52928861ed745202a47c6b739f3","b246ea98492a468e5903ff151e9bb1a087e78b9a1b29fc5d862bab8f8f3f1bdf","dd19bfbb6863692e9a6507504d51de07c2b589f6ee6ec577108c17c4c2cd408a"],
    python: true,
    repositoryTargets: ["scripts/job_apply_store/domains/coordinator/persistence.py","scripts/job_apply_store/normalization.py","scripts/job_apply_workspace/__init__.py","scripts/job_apply_workspace/http.py","tools/contracts/http-json-bytes/reference.py","tools/contracts/http-json-bytes/support.py"],
  },
  {
    identity: ["tests_js/installed_artifacts_reference.test.mjs","68c83aeb6be6a1d5b54a4e0f8cf59eafcd7933f375632291b1213d00a959a68f"],
    callHashes: ["2ef9dee1db6171ebd1b6c274df0273dca06ac69685303001140fe1d06c6552e4","e9bce9653e90afc865bb2a64717956e913de6ff36289f33f89a843f56f0eae0f"],
    python: true,
    repositoryTargets: ["scripts/smoke/artifacts.py","tools/contracts/installed-artifacts/reference.py","tools/contracts/installed-artifacts/support.py"],
  },
  {
    identity: ["tests_js/installed_artifacts_ts.test.mjs","a1b3c46216899cf214c2d76287fe3ae310124c6cfb101562630aab262fd9ea05"],
    callHashes: ["7227254685087c735275c2821c839aa11768e1f448449cb0ae67f466284bd83a","ce009343e3affae3fff2a49d4f6ae5458101c581608cbde19883afbafb1e5d6b","da5222f6d4b868533617456f6e9e588a4d631ba4e10f6255bb9c93339f4163f7","dd99184a6f8f33e1e753fe8388a6b3666f2ca41f0dcf603d4e02803a2d4e6850","efc9c91add2b48c2118fe300db5f5eab12cc27665af34d79d4a164e008738e42"],
    python: true,
    repositoryTargets: ["runtime/package/installed-artifacts.js","scripts/smoke/artifacts.py","tests_js/installed_artifacts_ts_support.mjs","tools/contracts/installed-artifacts/reference.py"],
    requiredSourceBindings: [{"path":"tests_js/installed_artifacts_ts_support.mjs","sha256":"0d354fb690fb4475b21a849069c5ea288cce056c4b1c5bfd75567587fc617f76"}],
  },
  {
    identity: ["tests_js/jsonl_append_reference.test.mjs","2f4ee1c18f2c4cdb3b59a2a6403cb113d4f7890b72fff57e1bc7655c49b0d66f"],
    callHashes: ["5ab9da73ed2e41613d65ad1047d8e58bf42c8e1c62ec1a372cdfdd4f971576b5","8bb379835eaec32f924b60194e384cbeb4330d5d37099ff8397b686d1f4293eb"],
    python: true,
    repositoryTargets: ["tools/contracts/jsonl-append/reference.py"],
  },
  {
    identity: ["tests_js/jsonl_history_ts.test.mjs","e86a23ae82f9b3c6412ead4836b21030edc2a551d4bf7e441dee1fb78c59cbb5"],
    callHashes: ["8bb379835eaec32f924b60194e384cbeb4330d5d37099ff8397b686d1f4293eb"],
    python: true,
    repositoryTargets: ["tools/contracts/jsonl-append/reference.py"],
  },
  {
    identity: ["tests_js/jsonl_json_ts.test.mjs","e607311957d866de4ff38b78a1fda86c39bb9f8b9a0bccf0a77d9eb045afb2f9"],
    callHashes: ["22c44818c6781f560aa8a737d4956bdcc6924a49ae034c8b76e88bd196b06612"],
    python: true,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/managed_observation_native_ts.test.mjs","d07d5037b3de7e0c922e99d22e5429b623bfaf536f44a9d091cb1370334b5101"],
    callHashes: ["04ef14b42831bec0481ddf412dffb7cd3432c99d94e10fc9f1d6c5efbc27a541","bcc8f163a553cec98fdd4e9bed4c1edf41f737701049ab92bea85fc6e6985aea"],
    python: true,
    repositoryTargets: ["scripts/job_apply_store/constants.py","scripts/job_apply_store/domains/resumes/storage.py","scripts/job_apply_store/normalization.py","tools/contracts/managed-observation/native.py"],
  },
  {
    identity: ["tests_js/managed_observation_reference.test.mjs","bbaf38d7ab716f0d0757c09cb7dabef820eb60572dca5abd817581953730821e"],
    callHashes: ["4f47d93fe909012037bb9967b7990d4699885425005355da337333cc334b31e2","5ab9da73ed2e41613d65ad1047d8e58bf42c8e1c62ec1a372cdfdd4f971576b5"],
    python: true,
    repositoryTargets: ["tools/contracts/managed-observation/reference.py"],
  },
  {
    identity: ["tests_js/managed_observation_ts.test.mjs","c82bb2057af3ea94f2ee00125f9e93c6f5b5858c0071ac738436def0fe526be5"],
    callHashes: ["4f47d93fe909012037bb9967b7990d4699885425005355da337333cc334b31e2"],
    python: true,
    repositoryTargets: ["tools/contracts/managed-observation/reference.py"],
  },
  {
    identity: ["tests_js/managed_resume_path_reference.test.mjs","e642dfed8368bf2f280d61b6b42f8f3b50264a0c418574677d3085b18cca4f36"],
    callHashes: ["7a7e7e118db4d2231c4292562fadf6cc112a514d691c754180f1baa9bf14090e","f64f21ec4ad4ea195324f5910ba90dce31fad262ddcfd2424ec9263341cc3f26"],
    python: true,
    repositoryTargets: ["tools/contracts/managed-resume-path/reference.py"],
  },
  {
    identity: ["tests_js/managed_resume_path_ts.test.mjs","1a960f4780737951c2c22917809afcb0c9d13b48b21fb63fe72ed095e99acd1b"],
    callHashes: ["13af0acca6a5f1172c832eac59ff68d97a3b39091dbec699cc61b90d344c2240","58421ce5bd9c0000ab77a6d91a9ce2a3a3087fe4e777fbb95bec3a940703943f","5bbe6695bada1a142389fea50c0b7198902b6e4d1d2782faaf28128a38414c0e","64f40503ae4191463b4ab6de2cd6c81bdebb71059f8bbd683261c34838bbad72"],
    python: true,
    repositoryTargets: ["scripts/job_apply_store/domains/resumes/storage.py","tools/contracts/managed-resume-path/reference.py"],
  },
  {
    identity: ["tests_js/persisted_json_ts.test.mjs","785b39a1c0348dcdfc53df5a3e968f86e18d789171e8b63568a0d3003ce3d9da"],
    callHashes: ["7e3b7a37fbbb04058f18e962df60cb5aa04b5602643d36721f7782342ae332ae"],
    python: true,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/posix_path_bytes_reference.test.mjs","a4e3153c2ff1dfa7a2ef4ba191d07aee8460d0d11122b9f6f7f308c1338dd6aa"],
    callHashes: ["0f45c132596674a9180c425591811d13f72081621cbc2d1f61e4aa0418f03ea3","46716f6447752e5c94e97b59432e4e3a4258271927eb8637680b3fa9dde57ef7"],
    python: true,
    repositoryTargets: ["tools/contracts/posix-path-bytes/reference.py"],
  },
  {
    identity: ["tests_js/posix_path_bytes_ts.test.mjs","c388412888b81f2cddcc560bd496ed7ba279ccbc0b67328cc85ed7447645b447"],
    callHashes: ["3243bbe85c5b26baf8a4c27a2a1a4834324325852366442988f681deb12129cd","a3947464df20de446e18cfd9b9b40786fe2b644b514d8ea3db3e2208b516395b","bb5f83a42829425b46a29b4d9115fee76ea6108cfe58d2a939291d7381743507"],
    python: true,
    repositoryTargets: ["scripts/job_apply_store/domains/resumes/storage.py","tools/contracts/posix-path-bytes/reference.py"],
  },
  {
    identity: ["tests_js/posix_timestamps.test.mjs","d7b6d83f09c440b399245ea7aa65ff17efdf72e2177f787163a8bdeb9cb4d801"],
    callHashes: ["81744a1f48dd2b1fc68f91f21529bf910b27fd84c9fa0325bb4432c30c626719"],
    python: true,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/private_file_digest_reference.test.mjs","8ea60743e987c0df0f5da922a13f5a8753f58fb506f5782b41313da66284dcd8"],
    callHashes: ["3d6db00403a03bd084e4839d1abf485d2cb07e995e7ce9357427ac092d4d5346","f5005534e7b9c2508f91a3f3f2d5441ee5469e5739dc7cc988b3c37993794dff"],
    python: true,
    repositoryTargets: ["tools/contracts/private-file-digest/reference.py"],
  },
  {
    identity: ["tests_js/private_file_digest_ts.test.mjs","9ad66c5de7f650a45734de66ee8e6bd9e5c27dbfa449ef35827a96fee761a98d"],
    callHashes: ["0400e7467afb361d81d0a5674c8df0ad0b0baac0f9d238bf5967226259f313ce"],
    python: true,
    repositoryTargets: ["tools/contracts/private-file-digest/reference.py"],
  },
  {
    identity: ["tests_js/python_json_bytes_reference.test.mjs","7c1c97f9582de1ce92ba5f2b6282b037ac09b0ddbd3112fdbb9606e4a7eb0eb8"],
    callHashes: ["8e6967b260a58fe709b6f71c8c71da4483216cfce3159688ffd2c40403ecfa54"],
    python: true,
    repositoryTargets: ["tools/contracts/python-json-bytes/reference.py"],
  },
  {
    identity: ["tests_js/python_json_ingress.test.mjs","788c43f05fa19450db80dcf1af133ad383d32602809a502fe996a7c0bebcba62"],
    callHashes: ["247872e3b7622486214eb1c5aec16b192b6de74cbc7761fe4297300043dc6fab","28b8fd491b403e59e89dd838645c272bc46d0177d1eb034418f5d339478f0ba6"],
    python: true,
    repositoryTargets: ["tools/contracts/json-ingress/reference.py"],
  },
  {
    identity: ["tests_js/python_json_stdin.test.mjs","cbd9e0a6cf500450804614b8900d4af9e6c51673e7bb4a79b42cdd2ac03d0db7"],
    callHashes: ["308e7511e8a4296877fa5b97fe5996180050ec628a2406187363ea4a3d5905c8","7794785b15b5c431fed685a14076675932e39e45a36c63c6e8845d32f9b0de29"],
    python: true,
    repositoryTargets: ["tools/contracts/json-ingress/stdin-reference.py"],
  },
  {
    identity: ["tests_js/python_object_reference.test.mjs","d53a6e27ab07fad36bfd82bc015994a4b915c639e6f4709afd28d0d8964b4dbd"],
    callHashes: ["faa8fd1f78ba648cdec697074f01bbdbd346ed4c9207cdc455c232856e1c3f1c"],
    python: true,
    repositoryTargets: ["tools/contracts/python-object/reference.py"],
  },
  {
    identity: ["tests_js/python_text_reference.test.mjs","b518d4e3f72c381bdbcc9288f0c19a9db750c6a415b70aa14acf9ace0975d119"],
    callHashes: ["5f2b91b7bd179937122f22ee2029d45456ac212893dd1401d5570026e1614ece","9e72c2288caaee84b87d99aa3b49b9d46ebc86b3e2db1cb3552f9fb6550721d1","a79791556eb42e3762154db8e32046f9dfb73393d8ecbdd8558c395fe9ba7597"],
    python: true,
    repositoryTargets: ["tools/contracts/python-text/reference.py"],
  },
  {
    identity: ["tests_js/python_text_ts.test.mjs","c278910ac938782dbfea8f049235d5a6bcfb32d4fc9ebe1f46d93d5129308585"],
    callHashes: ["4205d69a20aaffd33c8ae1d4812808ce4a8248899726bfe18dc77d3fa128ce3a","5f2b91b7bd179937122f22ee2029d45456ac212893dd1401d5570026e1614ece"],
    python: true,
    repositoryTargets: ["tools/contracts/python-text/reference.py"],
  },
  {
    identity: ["tests_js/python-answer-matching-raw.test.mjs","90741bcdaf696695c61871ac028c0960c754a3b16602b13f4d8ab56b6227c562"],
    callHashes: ["0341ecd3f95c77afdf6de194258d554c3d9e9c138bd23dc7f4ccb7311fc405f8","377c096a95bfb545ef5259fb52cb596e1cff3f2753a6242886e615d459b0f8f0","49faefe10ae460018c361ca3994e907e1616d90caf015965fb7407ad54627b5d","53cb368b42be96128d45b80a21321d99ff95a7e34790a60306f35c83b0697652"],
    python: true,
    repositoryTargets: ["tools/contracts/answer-matching-raw/capture.mjs","tools/contracts/answer-matching-raw/reference.py"],
  },
  {
    identity: ["tests_js/raw_json_numeric.test.mjs","cd7cf65c0e0d67e59a20bfce3e7a0edfe99f00168c2bfc76365524453a66b6c8"],
    callHashes: ["a2bd5518ca2d1de1b6d738379084df15fcf0638e92c39ea2a40340890d091ba4"],
    python: true,
    repositoryTargets: ["tools/contracts/raw-json-numeric/reference.py"],
  },
  {
    identity: ["tests_js/resume_modified_at_reference.test.mjs","1eff70f575a1d71baa04eca3ff79c15e44b04a7cfe5521c4288ac36d54c6bb7c"],
    callHashes: ["2ef9dee1db6171ebd1b6c274df0273dca06ac69685303001140fe1d06c6552e4","9b4147670729e0594de8c233b0090148311263367f28c6fb3b2e53f11854d2dd"],
    python: true,
    repositoryTargets: ["tools/contracts/resume-modified-at/reference.py"],
  },
  {
    identity: ["tests_js/resume_modified_at_ts.test.mjs","604ad7c6f9de181dc17b8526af397938a4799636c6e213a687a072bba209cd60"],
    callHashes: ["466735b9606254ba77eba93cd356c69bcb31c49685e1faad41c163005b70f1df","563d702743aa27d2759fd8e637fc2709268c7664c5a90db7e8a17b5c4593663c","712c077b49c5911f586acdd9bc3e0092728d7c8a1ac00960a8dced2abb4e2479","9eb4869a3f545a2e738124f3f3ce362b8882f8f108b965c72e87c6ba5d783ecb"],
    python: true,
    repositoryTargets: ["scripts/job_apply_store/normalization.py","tools/contracts/resume-modified-at/reference.py"],
  },
  {
    identity: ["tests_js/store_raw_read_reference.test.mjs","8b9ff859cefb7e8c825bc65530504b68637a77ed4de1b55a9631ad5d67ae91ff"],
    callHashes: ["a39f3f8aa28e121e031f132855c60c26a41cd8ca009c94266b6e0beecb738c94","db5bbda9818596358a0463f52bf19adf8cc2541c73cc9583125511adf4a06760"],
    python: true,
    repositoryTargets: ["tools/contracts/store-raw-read/reference.py"],
  },
  {
    identity: ["tests_js/store_raw_read_ts.test.mjs","2b9b97382a3c6ab0d7b09e9e95422251e6076cdaf8c7ddbd6bc01d872b6ad7d3"],
    callHashes: ["a39f3f8aa28e121e031f132855c60c26a41cd8ca009c94266b6e0beecb738c94"],
    python: true,
    repositoryTargets: ["tools/contracts/store-raw-read/reference.py"],
  },
  {
    identity: ["tests_js/store_validation_ts.test.mjs","3ea5a15d74374edd94c81e8a2bcb0bd39138cf9ae5e6865b3ad1c0f828e0f80e"],
    callHashes: ["933d9bf82e8272e87f87fbd9d800b86b41e9a89e02be35736914cc8bf32baa69","c573c9ca4e44eb7ae79fb36b14b4dbd2bd6e516877069578a5acfd19c144e636"],
    python: true,
    repositoryTargets: ["tools/contracts/store-validation/reference.py"],
  },
  {
    identity: ["tests_js/typed_json_oracle.test.mjs","427d7fd3abf4a2e8da8ab56c6dcdf9aec4956d0da9282e893682182c3bed7ae3"],
    callHashes: ["ba047299473d754a3c6b7899459d393bf3c0f8920c8816f5fb17f77a9f2f2296"],
    python: true,
    repositoryTargets: ["tools/contracts/typed-json/reference.py"],
  },
  {
    identity: ["tests_js/typed_json_points_profiles.test.mjs","fde848d7ea573350cba0a9cd541703beb4d5ce8057bf6137a2d4208dd8e251d7"],
    callHashes: ["751e0cded6007f4f53a4c05e26a2f3d26faeae02107044e01dd248c007a2a639"],
    python: true,
    repositoryTargets: ["docs/migration/evidence/s08/additional-reference-vectors.json","docs/migration/evidence/s08/composed-reference-vectors.json","tools/contracts/codepoint-json/reference.py"],
  },
  {
    identity: ["tools/contracts/answer-matching-raw/capture.mjs","2e4e35318723270289df72c00a7dd7226337eabba0eb82244587828af0c912f6"],
    callHashes: ["20f992c3cf3f4b6ae299c9aae51759da8f5442730105eec5962ba153306484e9","7a4c2f51319011ed2b27b53bfbbc83ddece278ae5d94e1d7c3effe691d8ba2ee"],
    python: true,
    repositoryTargets: ["tools/contracts/answer-matching-raw/reference.py"],
  },
  {
    identity: ["tests_js/migration_task_support.mjs","ddbf80c4d7559f7fd34ab4c9e72fd5b865555deffc8816ae58f20b7d5fef65a2"],
    callHashes: ["5800c5422c6ba656305d841822fd968a0c9adc1a577eba6e44569c325a03d964"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/python_text_acceptance.test.mjs","16103a567ec1701a4941bba6672a8b8c5857474e2c06e71058493b8bdd52dd35"],
    callHashes: ["bc0c948dd8ef84fa20b2362d0ee40e9860cb318fe3de1339af1bd655c8cd7950"],
    python: false,
    repositoryTargets: ["tests_js/python_text_ts.test.mjs"],
  },
  {
    identity: ["tests_js/python-profile-fact-contracts.test.mjs","4a8b263eceede5a7a9a5b5ef32a4d3de492e9b572c50503a671f128451083d90"],
    callHashes: ["d6c3c6790e23ebea651b0a4c9d3ef345f44f11c211f6ff6a1032e3e39cdb0bea"],
    python: false,
    repositoryTargets: ["tools/contracts/profile-facts/capture.mjs"],
  },
  {
    identity: ["tests_js/test-runner-selection.test.mjs", ["b881f69de5129de22e3a4cfa1f97aabf394b1b4d76dee3ad14acaebe6d629ad1", "648aa5c18777f407921fa144c9cde7e6dc26a149576c64d1da21b9827d2590b5"]],
    callHashes: ["9f03a02c35c07c0527cd5215fd89c8601be28616dd4f4c6da8b6886073710094", "9c0724b08e6e7a448ddbc75a5cb6bda837de0d46e4b3e9623f4592ec31f97653"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tools/local-checks/install.mjs","47bac92307376fd46f9948f1df4226cd51424f232dee1bc31945a971be8ecb8e"],
    callHashes: ["555ce444c2d6a741980dd091e1abec3a024ec61447489adfb385810d303cc6c6"],
    python: false,
    repositoryTargets: [".githooks/pre-commit",".githooks/pre-push"],
  },
  {
    identity: ["tools/local-checks/process.mjs","5a9bcd74638a9c2b89e69ae2730710a2ddac02906159b3ae8d012386e4f257db"],
    callHashes: ["cde3de65890c1a101c851018b043c0ccaf251c29853fdab4fd29385aad411aca"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tools/local-checks/run.mjs","3d109666337f7f650f903fdd6f455d86f2b84c6b286e605fe845b6c0fbf8cfcd"],
    callHashes: ["9476a24ffead4b4beebacc9c790b782e398ab3c7e8ed0df591fceee8b1fa2254"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tools/migration/check.mjs","d637bea2bf84e535b1437de123a3ffb3cca0dd9f7edb1663b60565ea59cae024"],
    callHashes: ["24dd7c96d8fb22955bd6bd605796c819fb1518a35aa440f703cdab2ad51e8afb"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tools/migration/evidence-io.mjs","b2105d8b36ef2d5e1c9859ac33d9a8243b96b2c9d1e94346b357782597eb56d7"],
    callHashes: ["af1feb31f36ba0a63e0f3ec2ef60f68072def9b8de1180d8d084553ba8f9da4a"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tools/test-runner/process.mjs","b9eea8bec5e3bb21a4bcb820c83414b798b7f25c336b1b639c2f179ca0c13d17"],
    callHashes: ["c17aa07aae9fc82329b7859cd32029af157cf77f7f32c6e79a8795c0ec2bc4a3"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/posix_timestamps.test.mjs","d7b6d83f09c440b399245ea7aa65ff17efdf72e2177f787163a8bdeb9cb4d801"],
    callHashes: ["603d14c0c3297fbbd3ff14e1858c287ee030a3a65d7b531fe05e18da1aede7a4"],
    python: false,
    repositoryTargets: ["runtime/package/posix-timestamps.js","tests_js/posix_timestamps_support.mjs","tools/build-native-timestamps.mjs"],
    requiredSourceBindings: [{"path":"tests_js/posix_timestamps_support.mjs","sha256":"2a163a8635a2816c48a607fdac1213d8f09a74fcc0b20d3372c248c5a297639a"},{"path":"tools/build-native-timestamps.mjs","sha256":"f4aacb8a496b1f668760d04e7ec15a17f26f474e74063ff55f10766876dc780e"}],
  },
  {
    identity: ["tests_js/local_checks_policy.test.mjs","edc832e87e436f4b5e4c636d9bcfb6a184170dbcc7f6bc147f8d009f6965f188"],
    callHashes: ["200c7ff1ebd36a20f7161899cc9a93f0aba1eda3ce46d70c1e71eb429a24dc4b"],
    python: false,
    repositoryTargets: ["tests_js/local_checks_graph_support.mjs"],
    requiredSourceBindings: [{"path":"tests_js/local_checks_graph_support.mjs","sha256":"1f7ba40d5d50f9441afc64a50d2299971abd291b5f235de3d4f01fd670229897"}],
  },
].flatMap(({ identity: [path, identities], ...recipe }) =>
  [identities].flat().map(sourceSha256 => ({
    path, sourceSha256, ...recipe,
  })),
);

// Each finite mapping is a specific reviewed expression, never all calls in its file.
export const FINITE_EXPRESSIONS = new Map([
  ['tests_js/workspace_test_support.mjs', ['import(pathToFileURL(join(REPO_ROOT, "workspace", "app.js")).href)']],
  ['tests_js/workspace_helpers_browser_ts.test.mjs', ['import(`/runtime/workspace-ui/lib/${group}-view.js`)', 'new URL(`../${path}`, import.meta.url)']],
  ['tests_js/typed_json_points.test.mjs', ['new URL(`../docs/migration/evidence/s08/${name}`, import.meta.url)']],
  ['tests_js/typed_json_points_profiles.test.mjs', ['new URL(`../docs/migration/evidence/s08/${name}`, import.meta.url)']],
  ['tests_js/migration_test_bindings.test.mjs', ['new URL(file, import.meta.url)']],
]);



// Set only after the complete query helper/import implementation receives independent review.
export const NPM_QUERY_SOURCE_SHA256 = '3a90057166e8ce16170cb5552876c1ca636428ac6bf8404df645424c72ab44ca';

// Identified native boundaries require the separately fresh native roots, never cached acceptance.


export const PYTHON_SOURCE_PATH = path => /\.(?:py|pyw|sh|bash)$/.test(path) || path.startsWith('.githooks/');
export const PYTHON_INVENTORY_SHA256 = '78742fd1dc69395209329ddaaf847f28d1d88fd2983528c13d5446755d855089';

export const EXTRA_CALLER_PROCESS_RECIPES = [
  {
    path: "tests_js/recorder_test_support.mjs",
    sourceSha256: "72ad22b18cd4759dd151d68ede19b6f1b707e915547ca293194c1cf4c2bce00e",
    callHashes: ["e471dfcedea07ae8574dd1420bf4d40dd3340c71c8b3a0e4aeb83c55ae06ae57","331e011e77094e916ea2522f57b695ba4347096f990057a2f936aa88dc299bdc","2c4b8be7a8f3c9823b706d15e0387cbb7b5229fa246f9c7fe0d56059a4c03c12"],
    python: true,
    repositoryTargets: ["qa/recorder.mjs","scripts/qa-chrome.py"],
    callers: [
      {"path":"tests_js/recorder.test.mjs","sha256":"2a4e858afb57f0ab3bc1f87a7c5efe21e04854b2ec48597229fae939d70cfa45"},
      {"path":"tests_js/recorder_ats_safety_greenhouse_ashby.test.mjs","sha256":"4d13162c904c0ea767424a628c891eda5223fda6d842c99f6cc3154dd42ddae4"},
      {"path":"tests_js/recorder_ats_safety_lever.test.mjs","sha256":"1113466320ba689932a694a09f58e6d2a3124752746dab33abb0e9bba3e574e5"},
      {"path":"tests_js/recorder_ats_safety_workday_linkedin.test.mjs","sha256":"154ae4e62b342576e8dd2de060673034b879705c5aea6f42950a753bfaa6a8e8"},
      {"path":"tests_js/recorder_broker.test.mjs","sha256":"b93a85414d0079ab64437fbaaa54bf5a6118a0ffa90b0564af3b4f63ddf9c136"},
      {"path":"tests_js/recorder_capture_browser.test.mjs","sha256":"b7e07e463819c5c5db08c6449e3c1f6a9ba3a25c665476e034d5c14683b30d0f"},
      {"path":"tests_js/recorder_capture_checkpoint_scenario.test.mjs","sha256":"b9da98761f12315d0a4076ac3e891b918d9b3fec5a08d69e1cf0ea7c67a8c95b"},
      {"path":"tests_js/recorder_capture_safety.test.mjs","sha256":"305f4812eecb82e272cea0282481ae3abb824793bfdfa3e15b83822897557720"},
      {"path":"tests_js/recorder_capture_unit.test.mjs","sha256":"e467832292d6c25bbf33279988fb58297df6e9fa5bae3fc3faddc84e47eaab8d"},
      {"path":"tests_js/recorder_capture_workday.test.mjs","sha256":"0d54f3d4812f78d0c3e4949df0daa7c9e41f9e978005b3c83c0982f575390cc4"},
      {"path":"tests_js/recorder_checkpoint_basics.test.mjs","sha256":"c552165fe236c1c8eada521af758b5ea05f1d7bcd18492fa44568b5a5cfa4174"},
      {"path":"tests_js/recorder_checkpoint_client.test.mjs","sha256":"3bc8ea66ec9539763fea8223744e79dd17c608118cdb9516abe0a2c49af0aa6b"},
      {"path":"tests_js/recorder_lifecycle_signals.test.mjs","sha256":"fdcb354e506b270040d904f883fe0873454fcaf481d6b22002d27e49917b52b7"},
      {"path":"tests_js/recorder_png_resources.test.mjs","sha256":"b8aa88bacd0a1c03034c8e68b34d7ad96a84f744b92ca26888a5848e163db7a9"},
      {"path":"tests_js/recorder_test_support.mjs","sha256":"72ad22b18cd4759dd151d68ede19b6f1b707e915547ca293194c1cf4c2bce00e"},
    ],
  },
  {
    path: "tests_js/renderer_test_support.mjs",
    sourceSha256: "eac0629c401f9d5c0d273caac6d86952738aed56dc5b644c7256e5f623a9532b",
    callHashes: ["63a2ae16b8f88b16d7f025743deb3253c73e700c7785c0e406fd675b5e9f466b"],
    python: true,
    repositoryTargets: ["qa/server.py","qa/__init__.py","qa/contracts.py","qa/server_auth.py","qa/server_events.py","qa/server_final_action.py","scripts/job_apply_policy.py","qa/renderer/index.html","qa/renderer/app.js","qa/renderer/styles.css","qa/fixtures/linkedin-easy-apply-screening-2026-08-v1/fixture.json"],
    callers: [
      {"path":"tests_js/renderer.test.mjs","sha256":"50c7701d2f05148a2116d00eb045849c8d99e51d0bd119ce4a8a8a4876ff0bd0"},
      {"path":"tests_js/renderer_ashby.test.mjs","sha256":"4bc9efb188dd590c3c5d8efbd3e62e4f6d9ae96726263ab373d76f54f5c0fa9a"},
      {"path":"tests_js/renderer_generic.test.mjs","sha256":"a0f8f573c6f24ae53885cbc287e411cd98ccd0e548ea4218b63734559300fae3"},
      {"path":"tests_js/renderer_greenhouse.test.mjs","sha256":"b121bd7c4328294701ac005ad7c0e0952648a9aae3f5c26d153a643480b2d42e"},
      {"path":"tests_js/renderer_lever.test.mjs","sha256":"594ff5e6403796538a52d7ab80be03a7b339da739141ec1a21b874517a74ad82"},
      {"path":"tests_js/renderer_test_support.mjs","sha256":"eac0629c401f9d5c0d273caac6d86952738aed56dc5b644c7256e5f623a9532b"},
    ],
    requiredSourceBindings: [{"path":"qa/renderer/index.html","sha256":"e8712f68b72db688e490f1f56ddc99bdde4e2f5f217b2431b5a3bec73079e34e"}],
  },
  {
    path: "tests_js/workspace_skill_support.mjs",
    sourceSha256: "0bb332ebf459b43129cad659375555b9145d07e7d9b139562d89bff87db3f458",
    callHashes: ["abd8aecb67959240163579e59f53c215c4896675b27b019eb297f0aa5357355e"],
    python: true,
    skillDocuments: true,
    repositoryTargets: ["scripts/skill_documents.py"],
    callers: [
      {"path":"tests_js/workspace_answers.test.mjs","sha256":"c3b6c03908af35d61f6b74ef113f069befe1993b2c0b350eaeed55957dd0c7c3"},
      {"path":"tests_js/workspace_markup.test.mjs","sha256":"dedfa6a03a6f4c238f1c687764698949246762255019e700fbaa9a8537b8e2f8"},
      {"path":"tests_js/workspace_skill_support.mjs","sha256":"0bb332ebf459b43129cad659375555b9145d07e7d9b139562d89bff87db3f458"},
    ],
  },
];

export const SKILL_SOURCE_PATH = path => /^skills\/(?:answer-memory|job-apply|job-workspace)\/.*\.md$/.test(path);
export const SKILL_INVENTORY_SHA256 = 'c59f8dd05c0b304706ea6eb2eab227636c4b4f575fc6a69c9b895f94629a3d03';
