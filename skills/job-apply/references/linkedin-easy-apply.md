### LinkedIn Easy Apply

**Characteristics:**
- Modal-based multi-step wizard
- Usually 2-5 steps: Contact Info → Resume → Additional Questions → Review
- Has progress indicator at top

**Approach:**
1. Click "Easy Apply" button to open modal
2. Use the active host browser’s page inspection on each step to identify fields
3. Common fields:
   - Phone number (often pre-filled from LinkedIn)
   - Resume upload (use the host browser's supported file-chooser flow with the resume path)
   - Work authorization questions (dropdowns)
   - Custom screening questions (varies by employer)
4. Click "Next" to advance, "Review" on final step
5. Stop on the review page, give a value-free field-name/status summary, and leave "Submit application" untouched for the user

**Field patterns to look for:**
- `input[name*="phone"]` - Phone number
- `input[type="file"]` - Resume upload
- `select`, `[role="listbox"]` - Dropdown questions
- `[role="radio"]`, `[role="checkbox"]` - Multiple choice
