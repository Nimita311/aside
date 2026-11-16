import { describe, expect, it } from 'vitest';
import { artifactResourcePath } from '../src/iframe-resource';
import type { Artifact } from '../../cli/src/core/types';
const source = '2026-10-12-dashboard', other = '2026-10-12-media';
const records = new Map<string, Artifact>([
  [source, {frontMatter:{name:'Dashboard',created:'2026-10-12T10:00',attachments:['index.html','chart.png']},body:''}],
  [other, {frontMatter:{name:'Media',created:'2026-10-12T10:00',attachments:['cover #1.svg']},body:''}],
]);
const lookup = (id:string)=>records.get(id);
describe('artifact resource resolution',()=>{
  it('reads only indexed attachment names, relative to the source artifact or a canonical handle',()=>{
    expect(artifactResourcePath(source,'./chart.png',lookup)).toBe(`artifacts/2026/${source}/chart.png`);
    expect(artifactResourcePath(source,`#artifact/${other}/cover%20%231.svg`,lookup)).toBe(`artifacts/2026/${other}/cover #1.svg`);
  });
  it.each(['../chart.png','/etc/passwd','https://example.com/chart.png','file:///etc/passwd','./unindexed.png',`#artifact/${other}`,`#artifact/${other}/../chart.png`,'#artifact/2026-10-12-missing/cover.svg'])('rejects unindexed or out-of-scope resource %s',reference=>{
    expect(()=>artifactResourcePath(source,reference,lookup)).toThrow();
  });
});
