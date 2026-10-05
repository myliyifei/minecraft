import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTerrain } from '../../src/core/terrain';

/**
 * 回归锁（#73）：换成地形对象之后，同一种子、同一区块坐标生成的区块与改动前逐字节相同。
 *
 * 期望值是改动前（提交 8c817e1）用 `plainsTerrain(seed)(cx, cz)` 生成的区块方块数组的 SHA-256，写死成字面量，
 * 不在测试里重算：重算就成了拿新实现对照新实现。
 *
 * #75 删除：三维密度地形换掉平原之后，生成结果本来就要变。
 */
const BEFORE_REFACTOR: ReadonlyArray<readonly [seed: number, cx: number, cz: number, sha256: string]> = [
  [20260905, 0, 0, '10c035dc7d8dba120460a3414b7aea43a38905dad6c540310b28f81976e73c20'],
  [20260905, -1, -1, 'ad8dbe216737456725c91455eaacda65a6c0f5fe42c89c7e2bd3105b9acc2622'],
  [20260905, 3, -2, '25cc3f42f274a282e9fa2ac0c649c6a4ac642e89c97d3bc8af92201a751cd470'],
  [20260905, -5, 7, '8c8ddb671cd3484d69a6c734db5a06b42ce8d407a05f65a1c376b83c499b97ee'],
  [20260905, 40, -33, 'd55acf429ca13e7ba9367db1c704d232cc0cf4729ffde7a923c4d181e9e948d8'],
  [1, 0, 0, '65a3eb9041e9d4a8114604d6cb515179f644bda4a4225e1f13c36986c4248d70'],
  [1, -1, -1, '80387c5bbf653e283dc02a3e4bb2fe561fa250d86d75ac5caecd8ead6914a3a0'],
  [1, 3, -2, 'e3a2a70d08819d2f87b4207ce9855fc159d8386dfa3ce0b42a4681fe95c245ac'],
  [1, -5, 7, '4944f89e0a77bbc0d5dd9a0c1e32e682589ccd6f846df056cf4ce31528b0b995'],
  [1, 40, -33, 'f44f1459e7825314828dc099b80a63af3959f62937171d254b4d9b6c2c289354'],
  [555, 0, 0, '3415aa08373a594501ca146864cbd27b8327699b50344a167537d30c134ee1a0'],
  [555, -1, -1, '9b2fa15cf26d4899e8b19cb8ca3c63c5929d58365b15b0eca05f2e2b08cdb110'],
  [555, 3, -2, 'f92c1dc23729ebfb3c9910a4b635872aacc7e243bfddf0eee032e520750d6344'],
  [555, -5, 7, '1c11ed173fda3d40e53e099519ba3a7ce6e8cb295f1998058822948441b969d8'],
  [555, 40, -33, 'f5f014ef9fa4c6cd3285617976e8645a3ab39938ee8909dba2b9676d0132be11'],
  [-123456789, 0, 0, '6e687f43a877693218a40a57ebf4b3a85951f1581b30a3fc250be224e45f4e4a'],
  [-123456789, -1, -1, '614c700f43aefd4909d74e7002d83d30d6a67b28bf0e1fbd8bfea8f97e4bb741'],
  [-123456789, 3, -2, 'bceb07040fcb15c166de9b45e72bd10df1a850435e792b670d66a6123245ddc3'],
  [-123456789, -5, 7, 'e3ba24d8e7535607ce4a548d84f5c2bb150401a7edce514fdd9b8a93a7cc3b5c'],
  [-123456789, 40, -33, 'dc55ff0e6f5da4c9e6c4a432119255ecb4ec072d864c9b0803bc518379c8b88e'],
];

describe('地形对象生成的区块与改动前逐字节相同（#75 删除）', () => {
  it.each(BEFORE_REFACTOR)('种子 %i 的区块 (%i, %i)', (seed, cx, cz, sha256) => {
    const blocks = createTerrain(seed).generateChunk(cx, cz).blocks;
    expect(createHash('sha256').update(blocks).digest('hex')).toBe(sha256);
  });
});
