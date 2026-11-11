import { co2 } from '@tgwf/co2';

// Estimated emissions per page view, with the Sustainable Web Design model (version 4) through the
// Green Web Foundation's CO2.js, worked out on this computer from how much the page downloaded.
// It's an estimate: the model averages data centres, networks and devices.

export type CarbonRating = 'A+' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export const CARBON_RATINGS: CarbonRating[] = ['A+', 'A', 'B', 'C', 'D', 'E', 'F'];

export interface CarbonEstimate {
  /** Grams of CO2 equivalent per page view. */
  grams: number;
  rating: CarbonRating;
}

const model = new co2({ model: 'swd', version: 4, rating: true });

/** Grams of CO2e per view of a page that downloads `bytes`, and its A+ to F rating. */
export function carbonFor(bytes: number, greenHosting = false): CarbonEstimate {
  const result = model.perVisit(Math.max(0, bytes), greenHosting) as { total: number; rating: CarbonRating };
  return { grams: Math.round(result.total * 1000) / 1000, rating: result.rating };
}
