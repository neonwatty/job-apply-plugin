export function OwnerWorkflow({ jobId }: {jobId:string}) {
    return <aside aria-label="Experimental owner workflow">
        <h3>Experimental owner workflow</h3>
        <p>To opt in, ask your agent to use the experimental owner workflow for saved job <code>{jobId}</code>, using the current application run and its confirmed managed resume.</p>
        <p>The agent checks code-provided actions and blockers. The agent verifies the managed resume upload and complete form before handing off for your manual review and submission, or stops at Needs information. Reading this guidance does not authorize an action.</p>
        <h4>Resume in the original chat</h4>
        <p>Return to the chat that owns the application tab. Ask the agent to inspect the existing draft and current workflow before continuing. A fresh chat may recover saved status without access to that draft.</p>
        <p>If the tab is missing, preserve the checkpoint and request a fresh attempt explicitly. Do not reopen the application link as a recovery shortcut.</p>
        <p>After a broker interruption, a live claim must expire before explicit recovery. Previously reviewed means historical completion; current browser readiness must be verified again. Final submission remains yours.</p>
    </aside>;
}
