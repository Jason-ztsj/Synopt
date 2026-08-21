import { randomInt } from 'node:crypto';

const COLORS = ['青色', '橙色', '银色', '靛蓝', '琥珀', '月白', '松绿', '绛红'];
const THINGS = ['海燕', '山雀', '纸船', '流星', '灯塔', '云朵', '溪流', '蒲公英'];

export function randomNickname() {
  const color = COLORS[randomInt(COLORS.length)];
  const thing = THINGS[randomInt(THINGS.length)];
  const suffix = String(randomInt(100, 1000));
  return `${color}${thing}${suffix}`;
}

