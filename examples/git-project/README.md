# Pump project

Copy this directory into its own Git repository, commit it, and set
`SCADA_PROJECT_REPO` to that repository's absolute path when starting SCADA.
The authenticated server transfers exactly the files listed in
`scada.project.json`. Each item in `scenes` is an independent declarative TS
scene. Other files are shown as text, not executed.

Select the degradation scenario to observe pump wear. These are synthetic
observations, not a hydraulic model or a connection to real equipment.
