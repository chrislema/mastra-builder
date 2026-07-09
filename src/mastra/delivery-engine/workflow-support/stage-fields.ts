import type { DeliveryWorkflowState } from '../workflow-schemas';

export function scaffoldStageFields(input: Partial<DeliveryWorkflowState>) {
  return {
    ...(input.scaffoldManifest ? { scaffoldManifest: input.scaffoldManifest } : {}),
    ...(input.scaffoldManifestPath ? { scaffoldManifestPath: input.scaffoldManifestPath } : {}),
  };
}

export function scaffoldManifestPromptSummary(manifest: DeliveryWorkflowState['scaffoldManifest'] | undefined) {
  if (!manifest) return null;
  return {
    profiles: manifest.profileList,
    language: manifest.language,
    main: manifest.main,
    generated_files: manifest.generatedFiles,
    binding_map: manifest.bindingMap,
    package_scripts: manifest.packageScripts,
    validation_commands: manifest.validationCommands,
    test_runtime_matrix: manifest.testRuntimeMatrix,
  };
}
