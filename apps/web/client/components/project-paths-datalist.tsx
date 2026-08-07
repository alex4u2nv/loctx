/**
 * Path suggestions shared by the /search and /find-literal path fields:
 * each active project's root plus the subtrees most JS/TS/Python
 * workspaces carry. Browsers ignore duplicate/absent values, so
 * over-suggesting is harmless. `<datalist>` renders nothing visible, so
 * placement is irrelevant; the path input references it by id
 * (`loctx-project-paths`).
 */

export const PROJECT_PATHS_DATALIST_ID = "loctx-project-paths";

const COMMON_SUBTREES = ["src", "apps", "packages", "lib", "tests"];

export function ProjectPathsDatalist({
  projects,
}: {
  projects: ReadonlyArray<{ id: string; root: string; name: string }> | undefined;
}) {
  return (
    <datalist id={PROJECT_PATHS_DATALIST_ID}>
      {projects?.flatMap((a) => [
        // Project root — broadest reasonable scope.
        <option key={a.id} value={a.root} label={a.name} />,
        ...COMMON_SUBTREES.map((sub) => (
          <option key={`${a.id}:${sub}`} value={`${a.root}/${sub}`} label={`${a.name}/${sub}`} />
        )),
      ])}
    </datalist>
  );
}
