{{/*
Common helpers for the agil-node chart.
*/}}

{{- define "agil-node.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agil-node.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "agil-node.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agil-node.labels" -}}
helm.sh/chart: {{ include "agil-node.chart" . }}
{{ include "agil-node.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end -}}

{{- define "agil-node.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agil-node.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "agil-node.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "agil-node.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "agil-node.secretName" -}}
{{- if .Values.enrollment.existingSecret -}}
{{- .Values.enrollment.existingSecret -}}
{{- else -}}
{{- include "agil-node.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "agil-node.nodeKeySecretName" -}}
{{- .Values.enrollment.nodeKeySecret | default (include "agil-node.secretName" .) -}}
{{- end -}}

{{- define "agil-node.image" -}}
{{- $registry := .Values.global.imageRegistry | default "" -}}
{{- $repository := .Values.image.repository -}}
{{- if .Values.image.digest -}}
{{- if $registry -}}
{{- printf "%s/%s@%s" $registry $repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s@%s" $repository .Values.image.digest -}}
{{- end -}}
{{- else -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repository .Values.image.tag -}}
{{- else -}}
{{- printf "%s:%s" $repository .Values.image.tag -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "agil-node.nodeId" -}}
{{- .Values.node.id | default (include "agil-node.fullname" .) -}}
{{- end -}}

{{- define "agil-node.nodeName" -}}
{{- .Values.node.name | default (include "agil-node.nodeId" .) -}}
{{- end -}}

{{- define "agil-node.endpoint" -}}
{{- if .Values.node.endpoint -}}
{{- .Values.node.endpoint -}}
{{- else -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.tls.enabled) .Values.domain -}}
{{- end -}}
{{- end -}}
