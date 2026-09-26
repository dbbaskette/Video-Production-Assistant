import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brandPaths } from './paths.js';
import {
  extractVerifiedMacRelease,
  TanzuBrandInstaller,
} from './tanzu-brand-installer.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function storedZip(files: Record<string, string>): Buffer {
  const records: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const bytes = Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    records.push(header, nameBytes, bytes);
  }
  const centralDirectoryMarker = Buffer.alloc(4);
  centralDirectoryMarker.writeUInt32LE(0x02014b50);
  return Buffer.concat([...records, centralDirectoryMarker]);
}

function releaseArchive(extra: Record<string, string> = {}): Buffer {
  return storedZip({
    'tanzu-brand/package.json': '{"name":"tanzu-brand","version":"1.2.3"}',
    'tanzu-brand/release.json': '{}',
    'tanzu-brand/SKILL.md': '# Tanzu Brand',
    'tanzu-brand/scripts/install-mac.mjs': '// installer',
    'Install-Tanzu-Brand.command': 'launcher',
    'Install-Tanzu-Brand.sh': 'shell',
    'START HERE.txt': 'guide',
    ...extra,
  });
}

describe('Tanzu Brand verified release extraction', () => {
  it('checks the archive digest and extracts only the nested package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpa-tanzu-extract-'));
    temporaryRoots.push(root);
    const archive = releaseArchive();
    const archivePath = join(root, 'release.zip');
    await writeFile(archivePath, archive);

    await extractVerifiedMacRelease(
      archivePath,
      join(root, 'verified'),
      createHash('sha256').update(archive).digest('hex'),
    );

    expect(await readFile(join(root, 'verified', 'SKILL.md'), 'utf8')).toBe('# Tanzu Brand');
  });

  it('rejects a mismatched checksum and unsafe archive paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpa-tanzu-extract-'));
    temporaryRoots.push(root);
    const archivePath = join(root, 'release.zip');
    const archive = releaseArchive({ '../escape': 'nope' });
    await writeFile(archivePath, archive);

    await expect(extractVerifiedMacRelease(archivePath, join(root, 'bad-hash'), '0'.repeat(64)))
      .rejects.toThrow(/did not match/);
    await expect(extractVerifiedMacRelease(
      archivePath,
      join(root, 'unsafe'),
      createHash('sha256').update(archive).digest('hex'),
    )).rejects.toThrow(/unsafe file layout/);
  });
});

describe('Tanzu Brand installer', () => {
  it('requires confirmation, downloads the fixed release assets, installs, and verifies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpa-tanzu-installer-'));
    temporaryRoots.push(root);
    const paths = brandPaths(join(root, 'workspace'), join(root, '.vpa'));
    const synchronize = vi.fn(async () => ({
      status: 'current' as const,
      root: '/verified/tanzu-brand',
      brandVersion: '2026.02',
      packageVersion: '1.2.3',
      vpaVersion: 1,
    }));
    const archive = releaseArchive();
    const digest = createHash('sha256').update(archive).digest('hex');
    const run = vi.fn(async (request: { executable: string; args: string[] }) => {
      if (request.executable === 'gh' && request.args[1] === 'view') {
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            tagName: 'v1.2.3',
            isDraft: false,
            isPrerelease: false,
            assets: [
              { name: 'tanzu-brand-1.2.3-mac.zip' },
              { name: 'tanzu-brand-1.2.3-mac.zip.sha256' },
            ],
          }),
        };
      }
      if (request.executable === 'gh' && request.args[1] === 'download') {
        const directory = request.args[request.args.indexOf('--dir') + 1]!;
        await writeFile(join(directory, 'tanzu-brand-1.2.3-mac.zip'), archive);
        await writeFile(join(directory, 'tanzu-brand-1.2.3-mac.zip.sha256'), `${digest}  tanzu-brand-1.2.3-mac.zip\n`);
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      return { exitCode: 0, stderr: '', stdout: 'installed' };
    });
    const installer = new TanzuBrandInstaller({
      paths,
      registryFile: paths.registryFile,
      platform: 'darwin',
      run,
      synchronize,
    });

    await expect(installer.start({ confirmed: false } as never)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const started = await installer.start({ confirmed: true });
    expect(started.state).toBe('installing');
    await installer.waitForIdle();
    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'ready',
      installed: true,
      packageVersion: '1.2.3',
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: process.execPath,
      args: expect.arrayContaining(['--yes', '--replace']),
    }));
  });

  it('fails cleanly when GitHub CLI access is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpa-tanzu-installer-'));
    temporaryRoots.push(root);
    const paths = brandPaths(join(root, 'workspace'), join(root, '.vpa'));
    const installer = new TanzuBrandInstaller({
      paths,
      registryFile: paths.registryFile,
      platform: 'darwin',
      synchronize: async () => ({ status: 'unavailable' }),
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'command not found: gh' }),
    });

    await installer.start({ confirmed: true });
    await installer.waitForIdle();
    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'error',
      installed: false,
      message: expect.stringContaining('Install GitHub CLI'),
    });
  });
});
