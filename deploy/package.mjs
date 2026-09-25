// Create an installable, credential-free source/image bundle from one explicitly selected Git commit.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createReadStream,createWriteStream,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createGzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';

const [approved,targetArg]=process.argv.slice(2);
assert(/^[a-f0-9]{40}$/.test(approved??'')&&targetArg,'PACKAGE_EXPECTED_SHA_AND_OUTPUT_REQUIRED');
const target=resolve(targetArg),temporary=mkdtempSync(join(tmpdir(),'mls-package-build-'));
const command=(exe,args,cwd=process.cwd(),input)=>{
  const result=spawnSync(exe,args,{cwd,input,encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024});
  assert.equal(result.status,0,'PACKAGE_COMMAND_FAILED_'+exe);return result.stdout.trim();
};
const digest=async file=>{const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');};
let created=false,complete=false;
try{
  assert.equal(command('git',['rev-parse','HEAD']),approved,'PACKAGE_SHA_NOT_CHECKED_OUT');
  command('git',['diff','--exit-code','HEAD','--']);
  assert(!existsSync(target),'PACKAGE_OUTPUT_EXISTS');mkdirSync(target,{mode:0o700});created=true;
  // Git archive excludes .git, ignored local configuration and all untracked runtime data.
  const paths=command('git',['ls-tree','-r','--name-only',approved]).split('\n');
  assert(paths.every(p=>!/(^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|data)(?:\/|$)|\.(?:sqlite(?:3)?|db)(?:-|$)/i.test(p)),'PACKAGE_TRACKED_PRIVATE_PATH');
  command('git',['archive','--format=tar.gz','--output='+join(target,'source.tar.gz'),approved]);
  command('tar',['-xzf',join(target,'source.tar.gz'),'-C',temporary,'--no-same-owner']);
  const lockfile=await digest(join(temporary,'package-lock.json'));
  const baseReference='node:24.20.0-bookworm-slim';command('docker',['pull',baseReference]);
  const base=JSON.parse(command('docker',['image','inspect',baseReference]))[0];
  const baseDigest=base.RepoDigests.find(d=>/^node@sha256:[a-f0-9]{64}$/.test(d));assert(baseDigest,'PACKAGE_BASE_DIGEST_MISSING');
  // Pin both build/runtime FROM lines to the downloaded immutable digest, without changing the source archive.
  const dockerfile=readFileSync(join(temporary,'deploy/Dockerfile'),'utf8');
  const buildfile=dockerfile.replaceAll(baseReference,baseDigest);assert.notEqual(buildfile,dockerfile,'PACKAGE_BASE_REFERENCE_CHANGED');
  writeFileSync(join(temporary,'deploy/Dockerfile.bundle'),buildfile);
  const tag='multi-llm-session:bundle-'+approved;
  command('docker',['build','-f','deploy/Dockerfile.bundle','--label','org.opencontainers.image.revision='+approved,'-t',tag,'.'],temporary);
  const image=JSON.parse(command('docker',['image','inspect',tag]))[0];
  assert.equal(image.Config.User,'node','PACKAGE_NONROOT_REQUIRED');assert.equal(image.Config.Labels['org.opencontainers.image.revision'],approved);
  const raw=join(temporary,'image.tar');command('docker',['image','save','-o',raw,tag]);
  await pipeline(createReadStream(raw),createGzip({level:6}),createWriteStream(join(target,'image.tar.gz'),{flags:'wx',mode:0o600}));
  const files={'source.tar.gz':await digest(join(target,'source.tar.gz')),'image.tar.gz':await digest(join(target,'image.tar.gz'))};
  const manifest={formatVersion:1,sourceSha:approved,sourceDateEpoch:Number(command('git',['show','-s','--format=%ct',approved])),lockfileSha256:lockfile,
    node:'24.20.0',baseImage:{reference:baseReference,digest:baseDigest},buildDockerfileSha256:createHash('sha256').update(buildfile).digest('hex'),
    image:{tag,id:image.Id,os:image.Os,architecture:image.Architecture,user:image.Config.User},files,
    evidenceMode:'credential-free-distribution',liveCalls:false,publishedToRegistry:false,
    reproducibility:'Exact source/lockfile and recorded immutable base and resulting image; future apt repositories and build timestamps are not claimed byte-identical.'};
  writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  files['manifest.json']=await digest(join(target,'manifest.json'));
  writeFileSync(join(target,'SHA256SUMS'),Object.entries(files).map(([file,sha])=>sha+'  '+file).join('\n')+'\n',{flag:'wx',mode:0o600});
  complete=true;console.log(JSON.stringify({sourceSha:approved,imageId:image.Id,files:Object.keys(files),publishedToRegistry:false}));
}finally{rmSync(temporary,{recursive:true,force:true});if(created&&!complete)rmSync(target,{recursive:true,force:true});}
