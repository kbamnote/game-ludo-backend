/**
 * How a captured character is taken out. Mirrors the mobile game/weapons.ts.
 *
 * The attacker chooses before its pawn sets off and sends the choice with the
 * move, so the server only has to validate it and pass it on unchanged.
 */
export const WEAPONS = ['punch', 'sword', 'gun', 'fireball', 'bomb', 'crystal', 'tornado', 'wave'] as const

export type Weapon = typeof WEAPONS[number]

/** Used for bots, timed-out turns and clients that send nothing. */
export const DEFAULT_WEAPON: Weapon = 'sword'

export function readWeapon(value: unknown): Weapon | undefined {
  return WEAPONS.find(weapon => weapon === value)
}
