import {jest, describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import fs from 'fs';

jest.unstable_mockModule('@actions/cache', () => ({
  saveCache: jest.fn(),
  restoreCache: jest.fn(),
  isFeatureAvailable: jest.fn()
}));

jest.unstable_mockModule('@actions/glob', () => ({
  create: jest.fn(),
  hashFiles: jest.fn()
}));

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  notice: jest.fn(),
  setFailed: jest.fn(),
  setOutput: jest.fn(),
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  getMultilineInput: jest.fn(),
  addPath: jest.fn(),
  exportVariable: jest.fn(),
  saveState: jest.fn(),
  getState: jest.fn(),
  setSecret: jest.fn(),
  isDebug: jest.fn(() => false),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  group: jest.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  toPlatformPath: jest.fn((p: string) => p),
  toWin32Path: jest.fn((p: string) => p),
  toPosixPath: jest.fn((p: string) => p)
}));

// Import real cache-utils (with mocked @actions) before mocking it
const realCacheUtils = await import('../src/cache-utils.js');

jest.unstable_mockModule('../src/cache-utils.js', () => ({
  ...realCacheUtils,
  getCacheDirectoryPath: jest.fn()
}));

const cache = await import('@actions/cache');
const core = await import('@actions/core');
const glob = await import('@actions/glob');
const cacheRestore = await import('../src/cache-restore.js');
const cacheUtils = await import('../src/cache-utils.js');
import type {PackageManagerInfo} from '../src/package-managers.js';

describe('restoreCache', () => {
  let hashFilesSpy: jest.Mock<typeof glob.hashFiles>;
  let getCacheDirectoryPathSpy: jest.Mock<
    typeof cacheUtils.getCacheDirectoryPath
  >;
  let restoreCacheSpy: jest.Mock<typeof cache.restoreCache>;
  let infoSpy: jest.Mock<typeof core.info>;
  let setOutputSpy: jest.Mock<typeof core.setOutput>;

  const versionSpec = '1.13.1';
  const packageManager = 'default';
  const cacheDependencyPath = 'path';
  const expectedPrimaryKey = () => {
    const linuxVersion =
      process.env.RUNNER_OS === 'Linux' ? `${process.env.ImageOS}-` : '';
    return `setup-go-${process.env.RUNNER_OS}-${process.arch}-${linuxVersion}go-${versionSpec}-file_hash`;
  };

  let originalWorkspace: string | undefined;
  let originalRestoredCaches: string | undefined;

  beforeEach(() => {
    originalWorkspace = process.env.GITHUB_WORKSPACE;
    originalRestoredCaches = process.env.SETUP_GO_RESTORED_CACHES;
    process.env.GITHUB_WORKSPACE = '/test/workspace';
    delete process.env.SETUP_GO_RESTORED_CACHES;
    //Arrange
    hashFilesSpy = glob.hashFiles as jest.Mock<typeof glob.hashFiles>;
    getCacheDirectoryPathSpy = cacheUtils.getCacheDirectoryPath as jest.Mock<
      typeof cacheUtils.getCacheDirectoryPath
    >;
    restoreCacheSpy = cache.restoreCache as jest.Mock<
      typeof cache.restoreCache
    >;
    infoSpy = core.info as jest.Mock<typeof core.info>;
    setOutputSpy = core.setOutput as jest.Mock<typeof core.setOutput>;

    getCacheDirectoryPathSpy.mockImplementation(
      (PackageManager: PackageManagerInfo) => {
        return Promise.resolve([
          'cache_directory_path',
          'cache_directory_path'
        ]);
      }
    );
  });

  afterEach(() => {
    process.env.GITHUB_WORKSPACE = originalWorkspace;
    if (originalRestoredCaches === undefined) {
      delete process.env.SETUP_GO_RESTORED_CACHES;
    } else {
      process.env.SETUP_GO_RESTORED_CACHES = originalRestoredCaches;
    }
    jest.restoreAllMocks();
  });

  it('should throw if dependency file path is not valid', async () => {
    // Arrange
    hashFilesSpy.mockImplementation(() => Promise.resolve(''));
    // Act + Assert
    await expect(
      cacheRestore.restoreCache(
        versionSpec,
        packageManager,
        cacheDependencyPath
      )
    ).rejects.toThrow(
      'Some specified paths were not resolved, unable to cache dependencies.'
    );
  });

  it('should inform if cache hit is not occurred', async () => {
    // Arrange
    hashFilesSpy.mockImplementation(() => Promise.resolve('file_hash'));
    restoreCacheSpy.mockImplementation(() => Promise.resolve(''));
    // Act + Assert
    await cacheRestore.restoreCache(
      versionSpec,
      packageManager,
      cacheDependencyPath
    );
    expect(infoSpy).toHaveBeenCalledWith('Cache is not found');
  });

  it('should set output if cache hit is occurred', async () => {
    // Arrange
    hashFilesSpy.mockImplementation(() => Promise.resolve('file_hash'));
    restoreCacheSpy.mockImplementation(() => Promise.resolve('cache_key'));
    // Act + Assert
    await cacheRestore.restoreCache(
      versionSpec,
      packageManager,
      cacheDependencyPath
    );
    expect(setOutputSpy).toHaveBeenCalledWith('cache-hit', true);
    expect(core.exportVariable).toHaveBeenCalledWith(
      'SETUP_GO_RESTORED_CACHES',
      JSON.stringify([
        cacheUtils.getRestoreIdentity(expectedPrimaryKey(), [
          'cache_directory_path',
          'cache_directory_path'
        ])
      ])
    );
  });

  it('should skip restoring a cache identity recorded from an earlier hit', async () => {
    hashFilesSpy.mockImplementation(() => Promise.resolve('file_hash'));
    process.env.SETUP_GO_RESTORED_CACHES = JSON.stringify([
      cacheUtils.getRestoreIdentity(expectedPrimaryKey(), [
        'cache_directory_path',
        'cache_directory_path'
      ])
    ]);

    await cacheRestore.restoreCache(
      versionSpec,
      packageManager,
      cacheDependencyPath
    );

    expect(restoreCacheSpy).not.toHaveBeenCalled();
    expect(setOutputSpy).toHaveBeenCalledWith('cache-hit', true);
    expect(core.saveState).toHaveBeenCalledWith(
      'CACHE_RESULT',
      expectedPrimaryKey()
    );
  });

  it('does not record a cache identity after a miss', async () => {
    hashFilesSpy.mockImplementation(() => Promise.resolve('file_hash'));
    restoreCacheSpy.mockImplementation(() => Promise.resolve(''));

    await cacheRestore.restoreCache(
      versionSpec,
      packageManager,
      cacheDependencyPath
    );

    expect(core.exportVariable).not.toHaveBeenCalled();
  });

  it('does not record a cache identity when restore throws', async () => {
    hashFilesSpy.mockImplementation(() => Promise.resolve('file_hash'));
    restoreCacheSpy.mockRejectedValue(new Error('restore failed'));

    await expect(
      cacheRestore.restoreCache(
        versionSpec,
        packageManager,
        cacheDependencyPath
      )
    ).rejects.toThrow('restore failed');

    expect(core.exportVariable).not.toHaveBeenCalled();
  });

  it('should throw if dependency file is not found in workspace', async () => {
    jest.spyOn(fs, 'readdirSync').mockReturnValue(['main.go'] as any);

    await expect(
      cacheRestore.restoreCache(
        versionSpec,
        packageManager
        // No cacheDependencyPath
      )
    ).rejects.toThrow(
      'Dependencies file is not found in /test/workspace. Supported file pattern: go.mod'
    );
  });
});
