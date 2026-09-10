import { createHash } from 'node:crypto';
export const now = '2026-09-10T12:00:00Z';
export const claim = {
  claimId:'fixture-claim',jobId:'job-1',ownerLabel:'Owner',tokenHash:createHash('sha256').update('secret').digest('hex'),
  acquiredAt:now,heartbeatAt:now,expiresAt:'2026-09-10T12:05:00Z',
};
export function fixture(overrides = {}) {
  return {coordinator:{schemaVersion:1,claim:{...claim}},jobs:{jobs:{'job-1':{status:'in_progress',deletedAt:null}}},
    now,jobId:'job-1',token:'secret',...overrides};
}
export function cases() {
  const rows = [];
  for (const value of [now,'20260910T120000Z','2026-W37-4T12Z','2026W374T12Z',
    '2026-09-10 12:00:00.1234569+02:30','2026-09-10x12:00:00,1-00:00:00.5',
    '2026-09-10T12.5+01:99','0001-01-01T00Z','9999-12-31T23:59:59.999999Z',
    '2026-02-30T12Z','2026-W53-1T00Z','2021-W53-1T00Z','2026-09-10','2026-09-10T12',
    '0001-01-01T00+01','9999-12-31T23:59:59-01','2026-09-10T24Z','2026-09-10T12+24','2026-09-10T12:99Z','invalid']) rows.push({op:'time',value});
  for (const token of ['secret','é😀','\ufeffsecret','',null,123,'\ud800','\ud800\udc00']) rows.push({op:'hash',token});
  for (const coordinator of [{schemaVersion:1,claim:null},{schemaVersion:true,claim:null},
    {schemaVersion:2,claim:null},{schemaVersion:0,claim:null},{schemaVersion:1},
    {schemaVersion:1,claim:[]},{schemaVersion:1,claim:42},{schemaVersion:1,claim:{...claim,extra:true}},{schemaVersion:1,claim:{...claim,ownerLabel:' '}},
    {schemaVersion:1,claim:{...claim,jobId:'../bad'}},{schemaVersion:1,claim:{...claim,expiresAt:'yesterday'}},
    {schemaVersion:1,claim:{...claim,tokenHash:'not-a-hash'}}, {schemaVersion:1,claim:{...claim}}]) rows.push({op:'validate',coordinator});
  for (const op of ['require','public','unclaimed']) {
    rows.push(fixture({op}));
    rows.push(fixture({op,now:'2026-09-10T12:05:00Z'}));
    rows.push(fixture({op,now:'2026-09-10T12:04:59.999999Z'}));
    rows.push(fixture({op,coordinator:{schemaVersion:1,claim:null}}));
    rows.push(fixture({op,jobId:'other'}));
  }
  for (const token of ['',null,'wrong','é','\ud800']) rows.push(fixture({op:'require',token}));
  rows.push(fixture({op:'require',now:'2026-09-10T12:05:00Z',allowExpired:true}));
  for (const job of [null,{status:'ready'},{status:'in_progress',deletedAt:'yesterday'}]) {
    rows.push(fixture({op:'require',jobs:{jobs:job === null ? {} : {'job-1':job}}}));
  }
  return rows;
}
