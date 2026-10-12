export function OwnerWorkflow({ jobId }: {jobId:string}) {
    return <aside aria-label="Experimental owner workflow">
        <h3>Experimental owner workflow</h3>
        <p>To opt in, ask your agent to use the experimental owner workflow for saved job <code>{jobId}</code>, using the current application run and its confirmed managed resume.</p>
        <p>The agent checks code-provided actions and blockers. The agent verifies the managed resume upload and complete form before handing off for your manual review and submission, or stops at Needs information. Reading this guidance does not authorize an action.</p>
    </aside>;
}
