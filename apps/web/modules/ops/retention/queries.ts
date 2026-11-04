/**
 * ops queries, area `retention`: the weekly retention list (R2) (ops spec 4.2). Created empty by ops-P1; ops-P7 adds
 * here: listRetentionCandidates, getWeeklyRetentionList, getPipelineBoard, getNoShowReport, getAbandonedCheckoutReport, getCapacityReport. Each query calls `requirePermission`, paginates at 50 rows and selects
 * named columns only.
 */
export {};
