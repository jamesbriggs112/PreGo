// CO2.js ships without type declarations. Only what Prego uses.
declare module '@tgwf/co2' {
  export class co2 {
    constructor(options?: { model?: 'swd' | '1byte'; version?: number; rating?: boolean });
    perVisit(bytes: number, green?: boolean): number | { total: number; rating: string };
  }
}
