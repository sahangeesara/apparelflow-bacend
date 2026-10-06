export type Role = 'cutting_supervisor' | 'cutting_verifier' | 'sewing_supervisor';
export type Flag = 'GREEN' | 'YELLOW' | 'RED';
export interface User { id: string; email: string; role: Role; full_name: string }
export interface Recipe { id: number; recipe_code: string; name: string; std_fabric_yards: number; wastage_cap: number; components: { id: number; component_name: string; pieces_per_garment: number }[] }
export interface Component { component_id: number; component_name: string; pieces_per_garment: number; expected_qty: number; actual_qty: number | null; status: Flag | null }
export interface Log { decision: 'APPROVED' | 'REJECTED'; rejection_note: string | null; wastage_pct: number; timestamp: string; verifier_name: string }
export interface Order {
  id: number; order_no: string; recipe_id: number; recipe_name: string; recipe_code: string; std_fabric_yards: number; wastage_cap: number;
  target_qty: number; fabric_roll_id: string; actual_fabric_yds: number; status: string; created_by_name: string;
  sewing_started_at: string | null; expected_fabric: number; components: Component[]; last_log: Log | null;
}
export const HOME: Record<Role, string> = { cutting_supervisor: '/supervisor', cutting_verifier: '/verifier', sewing_supervisor: '/sewing' };
