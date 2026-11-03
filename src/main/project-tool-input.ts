/** Only unambiguous local-model encoding errors are normalized. Ownership and
 * stale-write checks still happen in ProjectTools after schema validation. */
export function normalizeProjectToolInput(name: string, raw: unknown): unknown {
  if (name === 'update_project_task' && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const fields = raw as Record<string,unknown>;
    // Some local models encode the remaining argument object inside the first
    // array field, omitting only its opening object/key. Decode only that exact
    // wrapper shape; ordinary strict schema validation still runs afterward.
    if (Object.keys(fields).length === 1 && typeof fields.requirements === 'string' && fields.requirements.trimStart().startsWith('[')) {
      try { return JSON.parse('{"requirements":' + fields.requirements); } catch { /* Return unchanged for a useful schema error. */ }
    }
  }
  if (!['patch_project_file', 'edit_project_file'].includes(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  // Quoted JSON null still means create-only. The normal write precondition
  // rejects it if the path already exists; never apply this to patches.
  if (name === 'edit_project_file' && typeof value.path === 'string' && typeof value.content === 'string' &&
      (value.expectedHash === 'null' || value.expectedHash === undefined) && value.revision === undefined)
    return { ...value, expectedHash: null };
  if (value.revision === undefined && typeof value.expectedHash === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.expectedHash)) {
    const { expectedHash, ...rest } = value;
    return { ...rest, revision: expectedHash };
  }
  if (value.expectedHash === undefined && typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision)) {
    const { revision, ...rest } = value;
    return { ...rest, expectedHash: revision };
  }
  return raw;
}
