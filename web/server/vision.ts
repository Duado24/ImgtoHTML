import type { Box, Pixels } from "../src/core/types";

export interface VisionRegion {
  id: string;
  box: Box;
}

export interface RegionSuggestion {
  regionId: string;
  label: string;
  suggestedText: string;
  /** 0–1. */
  confidence: number;
}

/** Extension point only; no model is called by the conversion pipeline. */
export interface VisionModel {
  analyze(image: Pixels, regions: readonly VisionRegion[]): Promise<RegionSuggestion[]>;
}

export class NullVisionModel implements VisionModel {
  async analyze(_image: Pixels, _regions: readonly VisionRegion[]): Promise<RegionSuggestion[]> {
    return [];
  }
}
