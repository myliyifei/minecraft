import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/core/difficulty';
import { WORLD_NAME_MAX_LENGTH, worldNameValid, type WorldEntry, type WorldMeta } from '../../src/storage/world-storage';
import { entryButtons } from '../../src/ui/world-list';

function entry(meta: Partial<WorldMeta>, compatible = true): WorldEntry {
  return {
    meta: {
      id: 'w',
      name: '新的世界',
      seed: 1,
      difficulty: Difficulty.Normal,
      formatVersion: 1,
      terrainVersion: 1,
      createdAt: 0,
      lastPlayedAt: 0,
      hardcoreDead: false,
      ...meta,
    },
    compatible,
  };
}

describe('新建世界的名称', () => {
  it('1 到 32 个字符', () => {
    expect(WORLD_NAME_MAX_LENGTH).toBe(32);
    expect(worldNameValid('a')).toBe(true);
    expect(worldNameValid('新的世界')).toBe(true);
    expect(worldNameValid('字'.repeat(32))).toBe(true);
    expect(worldNameValid('字'.repeat(33))).toBe(false);
  });

  it('空的与只有空白的不行', () => {
    expect(worldNameValid('')).toBe(false);
    expect(worldNameValid('   ')).toBe(false);
  });
});

describe('世界列表里一条有哪些按钮', () => {
  it('能进入的世界：进入、导出、删除', () => {
    expect(entryButtons(entry({}))).toEqual({ enter: 'enabled', export: true, delete: true });
  });

  it('版本不兼容：进入禁用，仍能导出与删除', () => {
    expect(entryButtons(entry({}, false))).toEqual({ enter: 'disabled', export: true, delete: true });
  });

  it('极限已死亡：只剩删除', () => {
    const dead = entry({ difficulty: Difficulty.Hardcore, hardcoreDead: true });
    expect(entryButtons(dead)).toEqual({ enter: 'hidden', export: false, delete: true });
    // 又不兼容又已死亡，也只剩删除
    expect(entryButtons({ ...dead, compatible: false })).toEqual({ enter: 'hidden', export: false, delete: true });
  });
});
