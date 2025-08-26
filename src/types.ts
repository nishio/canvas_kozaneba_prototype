export interface ArgumentData {
  arg_id: string;
  argument: string;
  x: number;
  y: number;
  p: number;
  cluster_ids: string[];
  attributes: any;
  url: string | null;
}

export interface HierarchicalResult {
  arguments: ArgumentData[];
}

export interface Note {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  text: string;
  gridX: number;
  gridY: number;
}