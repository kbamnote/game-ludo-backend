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

/** A bot chooses for itself, so its captures are not all the same. */
export function randomWeapon(): Weapon {
  return WEAPONS[Math.floor(Math.random() * WEAPONS.length)]
}

/** Close-range weapons: the attacker walks over and strikes in contact. */
export const MELEE_WEAPONS: readonly Weapon[] = ['punch', 'sword']

/**
 * Anything else is a thrown power, cast from where the attacker stands before
 * it moves at all. That changes how long the clients spend on the capture.
 */
export function isRanged(weapon: Weapon | undefined): boolean {
  return weapon !== undefined && !MELEE_WEAPONS.includes(weapon)
}
