/**
 * Level 2 — CLEAR THE GAP: monumental scenery (non-gameplay decor), composed from the architecture
 * kit (@/render/level) and placed from the course data so it always follows the gameplay geometry.
 *
 *  - canyon: colossal stepped sandstone walls + eroded spires rising out of the cloud sea
 *  - architecture: start gate, kicker bodies, launch pylons, the cable-suspended ring gate (with a
 *    threading flash), the cable-stayed landing abutment on its stepped facility base
 * Decor has no physics; everything stays out of the driving / flight corridor.
 */
import { L2Canyon } from './level2/canyon';
import { L2KickerBodies, L2LandingStructure, L2LaunchPylons, L2RingSuspension, L2StartGate } from './level2/structures';

export function Level2Decor() {
  return (
    <>
      <L2Canyon />
      <L2StartGate />
      <L2KickerBodies />
      <L2LaunchPylons />
      <L2RingSuspension />
      <L2LandingStructure />
    </>
  );
}
