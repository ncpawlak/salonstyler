export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      ai_provider_config: {
        Row: {
          created_at: string;
          key_hint: string;
          key_updated_at: string;
          model: string;
          monthly_token_budget: number;
          provider: Database['public']['Enums']['ai_provider'];
          salon_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          key_hint: string;
          key_updated_at?: string;
          model: string;
          monthly_token_budget?: number;
          provider: Database['public']['Enums']['ai_provider'];
          salon_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string;
          key_hint?: string;
          key_updated_at?: string;
          model?: string;
          monthly_token_budget?: number;
          provider?: Database['public']['Enums']['ai_provider'];
          salon_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'ai_provider_config_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: true;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      ai_usage: {
        Row: {
          created_at: string;
          id: number;
          input_tokens: number;
          model: string;
          output_tokens: number;
          provider: Database['public']['Enums']['ai_provider'];
          purpose: string;
          salon_id: string;
          total_tokens: number | null;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: never;
          input_tokens: number;
          model: string;
          output_tokens: number;
          provider: Database['public']['Enums']['ai_provider'];
          purpose?: string;
          salon_id: string;
          total_tokens?: never;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          id?: never;
          input_tokens?: number;
          model?: string;
          output_tokens?: number;
          provider?: Database['public']['Enums']['ai_provider'];
          purpose?: string;
          salon_id?: string;
          total_tokens?: never;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'ai_usage_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      appointment_deposits: {
        Row: {
          amount_cents: number;
          appointment_id: string;
          created_at: string;
          currency: string;
          id: string;
          paid_at: string | null;
          pay_token: string;
          refunded_cents: number;
          resolution: string | null;
          resolved_at: string | null;
          salon_id: string;
          status: Database['public']['Enums']['deposit_status'];
          status_after: Database['public']['Enums']['appointment_status'];
          stripe_checkout_session_id: string | null;
          stripe_customer_id: string | null;
          stripe_payment_intent_id: string | null;
          stripe_payment_method_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          amount_cents: number;
          appointment_id: string;
          created_at?: string;
          currency: string;
          id?: string;
          paid_at?: string | null;
          pay_token?: string;
          refunded_cents?: number;
          resolution?: string | null;
          resolved_at?: string | null;
          salon_id: string;
          status?: Database['public']['Enums']['deposit_status'];
          status_after: Database['public']['Enums']['appointment_status'];
          stripe_checkout_session_id?: string | null;
          stripe_customer_id?: string | null;
          stripe_payment_intent_id?: string | null;
          stripe_payment_method_id?: string | null;
          updated_at?: string;
        };
        Update: {
          amount_cents?: number;
          appointment_id?: string;
          created_at?: string;
          currency?: string;
          id?: string;
          paid_at?: string | null;
          pay_token?: string;
          refunded_cents?: number;
          resolution?: string | null;
          resolved_at?: string | null;
          salon_id?: string;
          status?: Database['public']['Enums']['deposit_status'];
          status_after?: Database['public']['Enums']['appointment_status'];
          stripe_checkout_session_id?: string | null;
          stripe_customer_id?: string | null;
          stripe_payment_intent_id?: string | null;
          stripe_payment_method_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'appointment_deposits_appointment_fkey';
            columns: ['salon_id', 'appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'appointment_deposits_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      appointment_segments: {
        Row: {
          active: boolean;
          appointment_id: string;
          id: string;
          kind: Database['public']['Enums']['appointment_segment_kind'];
          label: string | null;
          position: number;
          range: unknown;
          salon_id: string;
          stylist_id: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          appointment_id: string;
          id?: string;
          kind: Database['public']['Enums']['appointment_segment_kind'];
          label?: string | null;
          position: number;
          range: unknown;
          salon_id: string;
          stylist_id: string;
        };
        Update: {
          active?: boolean;
          appointment_id?: string;
          id?: string;
          kind?: Database['public']['Enums']['appointment_segment_kind'];
          label?: string | null;
          position?: number;
          range?: unknown;
          salon_id?: string;
          stylist_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'appointment_segments_appointment_fkey';
            columns: ['salon_id', 'appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'appointment_segments_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      appointments: {
        Row: {
          cancel_reason: string | null;
          cancelled_at: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          hold_expires_at: string | null;
          id: string;
          import_key: string | null;
          manage_token: string;
          notes: string | null;
          price_cents: number | null;
          requested_at: string | null;
          salon_id: string;
          services: NonNullable<Json>;
          source: Database['public']['Enums']['appointment_source'];
          starts_at: string;
          status: Database['public']['Enums']['appointment_status'];
          stylist_id: string;
          text_reminder_sent_at: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          client_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          ends_at: string;
          hold_expires_at?: string | null;
          id?: string;
          import_key?: string | null;
          manage_token?: string;
          notes?: string | null;
          price_cents?: number | null;
          requested_at?: string | null;
          salon_id: string;
          services?: NonNullable<Json>;
          source?: Database['public']['Enums']['appointment_source'];
          starts_at: string;
          status?: Database['public']['Enums']['appointment_status'];
          stylist_id: string;
          text_reminder_sent_at?: string | null;
          updated_at?: string;
        };
        Update: {
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          client_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          ends_at?: string;
          hold_expires_at?: string | null;
          id?: string;
          import_key?: string | null;
          manage_token?: string;
          notes?: string | null;
          price_cents?: number | null;
          requested_at?: string | null;
          salon_id?: string;
          services?: NonNullable<Json>;
          source?: Database['public']['Enums']['appointment_source'];
          starts_at?: string;
          status?: Database['public']['Enums']['appointment_status'];
          stylist_id?: string;
          text_reminder_sent_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'appointments_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'client_summaries';
            referencedColumns: ['salon_id', 'client_id'];
          },
          {
            foreignKeyName: 'appointments_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'appointments_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      audit_log: {
        Row: {
          action: string;
          actor_user_id: string | null;
          created_at: string;
          details: NonNullable<Json>;
          entity_id: string | null;
          entity_type: string | null;
          id: number;
          salon_id: string;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          actor_user_id?: string | null;
          created_at?: string;
          details?: NonNullable<Json>;
          entity_id?: string | null;
          entity_type?: string | null;
          id?: never;
          salon_id: string;
        };
        Update: {
          action?: string;
          actor_user_id?: string | null;
          created_at?: string;
          details?: NonNullable<Json>;
          entity_id?: string | null;
          entity_type?: string | null;
          id?: never;
          salon_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'audit_log_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      captured_requests: {
        Row: {
          appointment_id: string | null;
          channel: string;
          client_created: boolean;
          client_id: string | null;
          created_at: string;
          dedupe_key: string;
          id: string;
          intent: Database['public']['Enums']['captured_request_intent'];
          message: string;
          note: string | null;
          parsed: NonNullable<Json>;
          received_at: string;
          resolved_at: string | null;
          salon_id: string;
          sender: string | null;
          sender_phone: string | null;
          status: Database['public']['Enums']['captured_request_status'];
          target_appointment_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          channel?: string;
          client_created?: boolean;
          client_id?: string | null;
          created_at?: string;
          dedupe_key: string;
          id?: string;
          intent: Database['public']['Enums']['captured_request_intent'];
          message: string;
          note?: string | null;
          parsed?: NonNullable<Json>;
          received_at?: string;
          resolved_at?: string | null;
          salon_id: string;
          sender?: string | null;
          sender_phone?: string | null;
          status?: Database['public']['Enums']['captured_request_status'];
          target_appointment_id?: string | null;
        };
        Update: {
          appointment_id?: string | null;
          channel?: string;
          client_created?: boolean;
          client_id?: string | null;
          created_at?: string;
          dedupe_key?: string;
          id?: string;
          intent?: Database['public']['Enums']['captured_request_intent'];
          message?: string;
          note?: string | null;
          parsed?: NonNullable<Json>;
          received_at?: string;
          resolved_at?: string | null;
          salon_id?: string;
          sender?: string | null;
          sender_phone?: string | null;
          status?: Database['public']['Enums']['captured_request_status'];
          target_appointment_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'captured_requests_appointment_fkey';
            columns: ['salon_id', 'appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'captured_requests_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'client_summaries';
            referencedColumns: ['salon_id', 'client_id'];
          },
          {
            foreignKeyName: 'captured_requests_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'captured_requests_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'captured_requests_target_fkey';
            columns: ['salon_id', 'target_appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
        ];
      };
      checkout_items: {
        Row: {
          amount_cents: number | null;
          checkout_id: string;
          id: string;
          kind: Database['public']['Enums']['checkout_item_kind'];
          name: string;
          position: number;
          quantity: number;
          salon_id: string;
          source_id: string | null;
          unit_amount_cents: number;
        };
        ComputedFields: never;
        Insert: {
          amount_cents?: never;
          checkout_id: string;
          id?: string;
          kind: Database['public']['Enums']['checkout_item_kind'];
          name: string;
          position: number;
          quantity?: number;
          salon_id: string;
          source_id?: string | null;
          unit_amount_cents: number;
        };
        Update: {
          amount_cents?: never;
          checkout_id?: string;
          id?: string;
          kind?: Database['public']['Enums']['checkout_item_kind'];
          name?: string;
          position?: number;
          quantity?: number;
          salon_id?: string;
          source_id?: string | null;
          unit_amount_cents?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'checkout_items_checkout_fkey';
            columns: ['salon_id', 'checkout_id'];
            isOneToOne: false;
            referencedRelation: 'checkouts';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'checkout_items_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      checkouts: {
        Row: {
          amount_due_cents: number;
          appointment_id: string | null;
          card_brand: string | null;
          card_last4: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          deposit_cents: number;
          id: string;
          method: Database['public']['Enums']['checkout_method'] | null;
          paid_at: string | null;
          rebook_appointment_id: string | null;
          rebook_declined_at: string | null;
          receipt_token: string;
          salon_id: string;
          status: Database['public']['Enums']['checkout_status'];
          stripe_payment_intent_id: string | null;
          subtotal_cents: number;
          tip_cents: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          amount_due_cents?: number;
          appointment_id?: string | null;
          card_brand?: string | null;
          card_last4?: string | null;
          client_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency: string;
          deposit_cents?: number;
          id?: string;
          method?: Database['public']['Enums']['checkout_method'] | null;
          paid_at?: string | null;
          rebook_appointment_id?: string | null;
          rebook_declined_at?: string | null;
          receipt_token?: string;
          salon_id: string;
          status?: Database['public']['Enums']['checkout_status'];
          stripe_payment_intent_id?: string | null;
          subtotal_cents?: number;
          tip_cents?: number;
          updated_at?: string;
        };
        Update: {
          amount_due_cents?: number;
          appointment_id?: string | null;
          card_brand?: string | null;
          card_last4?: string | null;
          client_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          deposit_cents?: number;
          id?: string;
          method?: Database['public']['Enums']['checkout_method'] | null;
          paid_at?: string | null;
          rebook_appointment_id?: string | null;
          rebook_declined_at?: string | null;
          receipt_token?: string;
          salon_id?: string;
          status?: Database['public']['Enums']['checkout_status'];
          stripe_payment_intent_id?: string | null;
          subtotal_cents?: number;
          tip_cents?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'checkouts_appointment_fkey';
            columns: ['salon_id', 'appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'checkouts_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'client_summaries';
            referencedColumns: ['salon_id', 'client_id'];
          },
          {
            foreignKeyName: 'checkouts_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'checkouts_rebook_appointment_fkey';
            columns: ['salon_id', 'rebook_appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'checkouts_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      client_email_outbox: {
        Row: {
          appointment_id: string;
          attempts: number;
          claimed_at: string | null;
          created_at: string;
          dedupe_key: string;
          id: string;
          kind: Database['public']['Enums']['client_email_kind'];
          last_error: string | null;
          provider_id: string | null;
          reminder_hours: number | null;
          salon_id: string;
          send_after: string;
          sent_at: string | null;
          starts_at: string;
          status: Database['public']['Enums']['notification_status'];
          to_email: string | null;
        };
        ComputedFields: never;
        Insert: {
          appointment_id: string;
          attempts?: number;
          claimed_at?: string | null;
          created_at?: string;
          dedupe_key: string;
          id?: string;
          kind: Database['public']['Enums']['client_email_kind'];
          last_error?: string | null;
          provider_id?: string | null;
          reminder_hours?: number | null;
          salon_id: string;
          send_after?: string;
          sent_at?: string | null;
          starts_at: string;
          status?: Database['public']['Enums']['notification_status'];
          to_email?: string | null;
        };
        Update: {
          appointment_id?: string;
          attempts?: number;
          claimed_at?: string | null;
          created_at?: string;
          dedupe_key?: string;
          id?: string;
          kind?: Database['public']['Enums']['client_email_kind'];
          last_error?: string | null;
          provider_id?: string | null;
          reminder_hours?: number | null;
          salon_id?: string;
          send_after?: string;
          sent_at?: string | null;
          starts_at?: string;
          status?: Database['public']['Enums']['notification_status'];
          to_email?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'client_email_outbox_appointment_id_fkey';
            columns: ['appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'client_email_outbox_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      client_formulas: {
        Row: {
          appointment_id: string | null;
          client_id: string;
          created_at: string;
          created_by: string | null;
          formula: string;
          id: string;
          notes: string | null;
          salon_id: string;
          service_name: string | null;
          updated_at: string;
          visit_date: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          client_id: string;
          created_at?: string;
          created_by?: string | null;
          formula: string;
          id?: string;
          notes?: string | null;
          salon_id: string;
          service_name?: string | null;
          updated_at?: string;
          visit_date?: string;
        };
        Update: {
          appointment_id?: string | null;
          client_id?: string;
          created_at?: string;
          created_by?: string | null;
          formula?: string;
          id?: string;
          notes?: string | null;
          salon_id?: string;
          service_name?: string | null;
          updated_at?: string;
          visit_date?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'client_formulas_appointment_fkey';
            columns: ['salon_id', 'appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'client_formulas_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'client_summaries';
            referencedColumns: ['salon_id', 'client_id'];
          },
          {
            foreignKeyName: 'client_formulas_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'client_formulas_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      client_notes: {
        Row: {
          body: string;
          client_id: string;
          created_at: string;
          created_by: string | null;
          id: string;
          pinned: boolean;
          salon_id: string;
          source: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          client_id: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          pinned?: boolean;
          salon_id: string;
          source?: string;
          updated_at?: string;
        };
        Update: {
          body?: string;
          client_id?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          pinned?: boolean;
          salon_id?: string;
          source?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'client_notes_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'client_summaries';
            referencedColumns: ['salon_id', 'client_id'];
          },
          {
            foreignKeyName: 'client_notes_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'client_notes_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      client_photos: {
        Row: {
          appointment_id: string | null;
          caption: string | null;
          client_id: string;
          created_at: string;
          created_by: string | null;
          id: string;
          kind: string;
          salon_id: string;
          storage_path: string;
          taken_at: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          caption?: string | null;
          client_id: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind?: string;
          salon_id: string;
          storage_path: string;
          taken_at?: string;
        };
        Update: {
          appointment_id?: string | null;
          caption?: string | null;
          client_id?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind?: string;
          salon_id?: string;
          storage_path?: string;
          taken_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'client_photos_appointment_fkey';
            columns: ['salon_id', 'appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'client_photos_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'client_summaries';
            referencedColumns: ['salon_id', 'client_id'];
          },
          {
            foreignKeyName: 'client_photos_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'client_photos_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      client_replies: {
        Row: {
          appointment_id: string | null;
          body: string | null;
          captured_request_id: string | null;
          channel: string;
          claimed_at: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          kind: string;
          salon_id: string;
          sent_at: string | null;
          source: string | null;
          status: string;
          to_phone: string | null;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          body?: string | null;
          captured_request_id?: string | null;
          channel: string;
          claimed_at?: string | null;
          client_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind: string;
          salon_id: string;
          sent_at?: string | null;
          source?: string | null;
          status?: string;
          to_phone?: string | null;
        };
        Update: {
          appointment_id?: string | null;
          body?: string | null;
          captured_request_id?: string | null;
          channel?: string;
          claimed_at?: string | null;
          client_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind?: string;
          salon_id?: string;
          sent_at?: string | null;
          source?: string | null;
          status?: string;
          to_phone?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'client_replies_appointment_fkey';
            columns: ['salon_id', 'appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'client_replies_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'client_summaries';
            referencedColumns: ['salon_id', 'client_id'];
          },
          {
            foreignKeyName: 'client_replies_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'client_replies_request_fkey';
            columns: ['salon_id', 'captured_request_id'];
            isOneToOne: false;
            referencedRelation: 'captured_requests';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'client_replies_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      client_service_overrides: {
        Row: {
          client_id: string;
          created_at: string;
          created_by: string | null;
          delta_minutes: number;
          id: string;
          note: string | null;
          salon_id: string;
          segment_index: number | null;
          service_id: string;
          source: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          client_id: string;
          created_at?: string;
          created_by?: string | null;
          delta_minutes: number;
          id?: string;
          note?: string | null;
          salon_id: string;
          segment_index?: number | null;
          service_id: string;
          source?: string;
          updated_at?: string;
        };
        Update: {
          client_id?: string;
          created_at?: string;
          created_by?: string | null;
          delta_minutes?: number;
          id?: string;
          note?: string | null;
          salon_id?: string;
          segment_index?: number | null;
          service_id?: string;
          source?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'client_service_overrides_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'client_summaries';
            referencedColumns: ['salon_id', 'client_id'];
          },
          {
            foreignKeyName: 'client_service_overrides_client_fkey';
            columns: ['salon_id', 'client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'client_service_overrides_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'client_service_overrides_service_fkey';
            columns: ['salon_id', 'service_id'];
            isOneToOne: false;
            referencedRelation: 'services';
            referencedColumns: ['salon_id', 'id'];
          },
        ];
      };
      clients: {
        Row: {
          birthday: string | null;
          created_at: string;
          email: string | null;
          id: string;
          imported_last_visit_on: string | null;
          imported_no_show_count: number;
          marketing_opt_in: boolean;
          name: string;
          notes: string | null;
          pending: boolean;
          phone: string | null;
          preferred_service_ids: string[];
          salon_id: string;
          tags: string[];
          updated_at: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          birthday?: string | null;
          created_at?: string;
          email?: string | null;
          id?: string;
          imported_last_visit_on?: string | null;
          imported_no_show_count?: number;
          marketing_opt_in?: boolean;
          name: string;
          notes?: string | null;
          pending?: boolean;
          phone?: string | null;
          preferred_service_ids?: string[];
          salon_id: string;
          tags?: string[];
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          birthday?: string | null;
          created_at?: string;
          email?: string | null;
          id?: string;
          imported_last_visit_on?: string | null;
          imported_no_show_count?: number;
          marketing_opt_in?: boolean;
          name?: string;
          notes?: string | null;
          pending?: boolean;
          phone?: string | null;
          preferred_service_ids?: string[];
          salon_id?: string;
          tags?: string[];
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'clients_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      form_submissions: {
        Row: {
          answers: NonNullable<Json>;
          appointment_id: string | null;
          client_id: string;
          fields: NonNullable<Json>;
          id: string;
          salon_id: string;
          submitted_at: string;
          template_id: string | null;
          template_name: string;
        };
        ComputedFields: never;
        Insert: {
          answers: NonNullable<Json>;
          appointment_id?: string | null;
          client_id: string;
          fields: NonNullable<Json>;
          id?: string;
          salon_id: string;
          submitted_at?: string;
          template_id?: string | null;
          template_name: string;
        };
        Update: {
          answers?: NonNullable<Json>;
          appointment_id?: string | null;
          client_id?: string;
          fields?: NonNullable<Json>;
          id?: string;
          salon_id?: string;
          submitted_at?: string;
          template_id?: string | null;
          template_name?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'form_submissions_appointment_id_fkey';
            columns: ['appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'form_submissions_client_id_fkey';
            columns: ['client_id'];
            isOneToOne: false;
            referencedRelation: 'client_summaries';
            referencedColumns: ['client_id'];
          },
          {
            foreignKeyName: 'form_submissions_client_id_fkey';
            columns: ['client_id'];
            isOneToOne: false;
            referencedRelation: 'clients';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'form_submissions_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'form_submissions_template_id_fkey';
            columns: ['template_id'];
            isOneToOne: false;
            referencedRelation: 'form_templates';
            referencedColumns: ['id'];
          },
        ];
      };
      form_templates: {
        Row: {
          ask_new_clients: boolean;
          created_at: string;
          description: string | null;
          fields: NonNullable<Json>;
          id: string;
          name: string;
          salon_id: string;
          starter_key: string | null;
          updated_at: string;
          valid_days: number | null;
        };
        ComputedFields: never;
        Insert: {
          ask_new_clients?: boolean;
          created_at?: string;
          description?: string | null;
          fields: NonNullable<Json>;
          id?: string;
          name: string;
          salon_id: string;
          starter_key?: string | null;
          updated_at?: string;
          valid_days?: number | null;
        };
        Update: {
          ask_new_clients?: boolean;
          created_at?: string;
          description?: string | null;
          fields?: NonNullable<Json>;
          id?: string;
          name?: string;
          salon_id?: string;
          starter_key?: string | null;
          updated_at?: string;
          valid_days?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'form_templates_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      inbox_bridges: {
        Row: {
          auto_reply: boolean;
          created_at: string;
          keyword: string;
          last_bridge_version: string | null;
          last_received_at: string | null;
          last_test_at: string | null;
          phone: string | null;
          rotated_at: string;
          salon_id: string;
          token_hash: string;
          token_hint: string;
          window_count: number;
          window_started_at: string;
        };
        ComputedFields: never;
        Insert: {
          auto_reply?: boolean;
          created_at?: string;
          keyword?: string;
          last_bridge_version?: string | null;
          last_received_at?: string | null;
          last_test_at?: string | null;
          phone?: string | null;
          rotated_at?: string;
          salon_id: string;
          token_hash: string;
          token_hint: string;
          window_count?: number;
          window_started_at?: string;
        };
        Update: {
          auto_reply?: boolean;
          created_at?: string;
          keyword?: string;
          last_bridge_version?: string | null;
          last_received_at?: string | null;
          last_test_at?: string | null;
          phone?: string | null;
          rotated_at?: string;
          salon_id?: string;
          token_hash?: string;
          token_hint?: string;
          window_count?: number;
          window_started_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'inbox_bridges_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: true;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications_outbox: {
        Row: {
          appointment_id: string | null;
          attempts: number;
          body: string;
          category: string | null;
          claimed_at: string | null;
          created_at: string;
          data: NonNullable<Json>;
          dedupe_key: string;
          id: string;
          kind: Database['public']['Enums']['notification_kind'];
          last_error: string | null;
          salon_id: string;
          send_after: string;
          sent_at: string | null;
          status: Database['public']['Enums']['notification_status'];
          tickets: Json | null;
          title: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          attempts?: number;
          body: string;
          category?: string | null;
          claimed_at?: string | null;
          created_at?: string;
          data?: NonNullable<Json>;
          dedupe_key: string;
          id?: string;
          kind: Database['public']['Enums']['notification_kind'];
          last_error?: string | null;
          salon_id: string;
          send_after?: string;
          sent_at?: string | null;
          status?: Database['public']['Enums']['notification_status'];
          tickets?: Json | null;
          title: string;
          user_id: string;
        };
        Update: {
          appointment_id?: string | null;
          attempts?: number;
          body?: string;
          category?: string | null;
          claimed_at?: string | null;
          created_at?: string;
          data?: NonNullable<Json>;
          dedupe_key?: string;
          id?: string;
          kind?: Database['public']['Enums']['notification_kind'];
          last_error?: string | null;
          salon_id?: string;
          send_after?: string;
          sent_at?: string | null;
          status?: Database['public']['Enums']['notification_status'];
          tickets?: Json | null;
          title?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_outbox_appointment_id_fkey';
            columns: ['appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_outbox_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      payments: {
        Row: {
          amount_cents: number;
          amount_refunded_cents: number;
          appointment_id: string | null;
          created_at: string;
          currency: string;
          description: string | null;
          failure_message: string | null;
          id: string;
          livemode: boolean;
          salon_id: string;
          status: Database['public']['Enums']['payment_status'];
          stripe_account_id: string | null;
          stripe_charge_id: string | null;
          stripe_payment_intent_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          amount_cents: number;
          amount_refunded_cents?: number;
          appointment_id?: string | null;
          created_at?: string;
          currency: string;
          description?: string | null;
          failure_message?: string | null;
          id?: string;
          livemode?: boolean;
          salon_id: string;
          status: Database['public']['Enums']['payment_status'];
          stripe_account_id?: string | null;
          stripe_charge_id?: string | null;
          stripe_payment_intent_id: string;
          updated_at?: string;
        };
        Update: {
          amount_cents?: number;
          amount_refunded_cents?: number;
          appointment_id?: string | null;
          created_at?: string;
          currency?: string;
          description?: string | null;
          failure_message?: string | null;
          id?: string;
          livemode?: boolean;
          salon_id?: string;
          status?: Database['public']['Enums']['payment_status'];
          stripe_account_id?: string | null;
          stripe_charge_id?: string | null;
          stripe_payment_intent_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'payments_appointment_fkey';
            columns: ['salon_id', 'appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'payments_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      products: {
        Row: {
          active: boolean;
          barcode: string | null;
          brand: string | null;
          category: string | null;
          cost_cents: number | null;
          created_at: string;
          id: string;
          name: string;
          on_hand: number;
          reorder_point: number;
          reorder_quantity: number | null;
          retail_price_cents: number | null;
          salon_id: string;
          sku: string | null;
          supplier: string | null;
          unit: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          barcode?: string | null;
          brand?: string | null;
          category?: string | null;
          cost_cents?: number | null;
          created_at?: string;
          id?: string;
          name: string;
          on_hand?: number;
          reorder_point?: number;
          reorder_quantity?: number | null;
          retail_price_cents?: number | null;
          salon_id: string;
          sku?: string | null;
          supplier?: string | null;
          unit?: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          barcode?: string | null;
          brand?: string | null;
          category?: string | null;
          cost_cents?: number | null;
          created_at?: string;
          id?: string;
          name?: string;
          on_hand?: number;
          reorder_point?: number;
          reorder_quantity?: number | null;
          retail_price_cents?: number | null;
          salon_id?: string;
          sku?: string | null;
          supplier?: string | null;
          unit?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'products_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      push_tokens: {
        Row: {
          created_at: string;
          id: string;
          last_seen_at: string;
          platform: Database['public']['Enums']['push_platform'];
          salon_id: string;
          token: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          last_seen_at?: string;
          platform: Database['public']['Enums']['push_platform'];
          salon_id: string;
          token: string;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          last_seen_at?: string;
          platform?: Database['public']['Enums']['push_platform'];
          salon_id?: string;
          token?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'push_tokens_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      salon_members: {
        Row: {
          created_at: string;
          role: Database['public']['Enums']['salon_role'];
          salon_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          role?: Database['public']['Enums']['salon_role'];
          salon_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          role?: Database['public']['Enums']['salon_role'];
          salon_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'salon_members_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      salons: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          slug: string;
          timezone: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          slug: string;
          timezone: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          slug?: string;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      service_addons: {
        Row: {
          archived_at: string | null;
          bookable_online: boolean;
          created_at: string;
          id: string;
          name: string;
          placement: Database['public']['Enums']['addon_placement'];
          position: number;
          price_cents: number | null;
          salon_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          bookable_online?: boolean;
          created_at?: string;
          id?: string;
          name: string;
          placement?: Database['public']['Enums']['addon_placement'];
          position?: number;
          price_cents?: number | null;
          salon_id: string;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          bookable_online?: boolean;
          created_at?: string;
          id?: string;
          name?: string;
          placement?: Database['public']['Enums']['addon_placement'];
          position?: number;
          price_cents?: number | null;
          salon_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'service_addons_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      service_combo_items: {
        Row: {
          combo_id: string;
          position: number;
          replaces_previous_finish: boolean;
          salon_id: string;
          service_id: string;
        };
        ComputedFields: never;
        Insert: {
          combo_id: string;
          position: number;
          replaces_previous_finish?: boolean;
          salon_id: string;
          service_id: string;
        };
        Update: {
          combo_id?: string;
          position?: number;
          replaces_previous_finish?: boolean;
          salon_id?: string;
          service_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'service_combo_items_combo_fkey';
            columns: ['salon_id', 'combo_id'];
            isOneToOne: false;
            referencedRelation: 'services';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'service_combo_items_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'service_combo_items_service_fkey';
            columns: ['salon_id', 'service_id'];
            isOneToOne: false;
            referencedRelation: 'services';
            referencedColumns: ['salon_id', 'id'];
          },
        ];
      };
      service_form_requirements: {
        Row: {
          created_at: string;
          salon_id: string;
          service_id: string;
          template_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          salon_id: string;
          service_id: string;
          template_id: string;
        };
        Update: {
          created_at?: string;
          salon_id?: string;
          service_id?: string;
          template_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'service_form_requirements_salon_id_service_id_fkey';
            columns: ['salon_id', 'service_id'];
            isOneToOne: false;
            referencedRelation: 'services';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'service_form_requirements_salon_id_template_id_fkey';
            columns: ['salon_id', 'template_id'];
            isOneToOne: false;
            referencedRelation: 'form_templates';
            referencedColumns: ['salon_id', 'id'];
          },
        ];
      };
      service_segments: {
        Row: {
          addon_id: string | null;
          created_at: string;
          id: string;
          kind: Database['public']['Enums']['segment_kind'];
          label: string | null;
          minutes: number;
          position: number;
          salon_id: string;
          service_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          addon_id?: string | null;
          created_at?: string;
          id?: string;
          kind: Database['public']['Enums']['segment_kind'];
          label?: string | null;
          minutes: number;
          position: number;
          salon_id: string;
          service_id?: string | null;
        };
        Update: {
          addon_id?: string | null;
          created_at?: string;
          id?: string;
          kind?: Database['public']['Enums']['segment_kind'];
          label?: string | null;
          minutes?: number;
          position?: number;
          salon_id?: string;
          service_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'service_segments_addon_fkey';
            columns: ['salon_id', 'addon_id'];
            isOneToOne: false;
            referencedRelation: 'service_addons';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'service_segments_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'service_segments_service_fkey';
            columns: ['salon_id', 'service_id'];
            isOneToOne: false;
            referencedRelation: 'services';
            referencedColumns: ['salon_id', 'id'];
          },
        ];
      };
      service_variants: {
        Row: {
          created_at: string;
          delta_minutes: number;
          id: string;
          name: string;
          position: number;
          salon_id: string;
          service_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          delta_minutes?: number;
          id?: string;
          name: string;
          position?: number;
          salon_id: string;
          service_id: string;
        };
        Update: {
          created_at?: string;
          delta_minutes?: number;
          id?: string;
          name?: string;
          position?: number;
          salon_id?: string;
          service_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'service_variants_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'service_variants_service_fkey';
            columns: ['salon_id', 'service_id'];
            isOneToOne: false;
            referencedRelation: 'services';
            referencedColumns: ['salon_id', 'id'];
          },
        ];
      };
      services: {
        Row: {
          archived_at: string | null;
          bookable_online: boolean;
          buffer_after_minutes: number;
          buffer_before_minutes: number;
          category: string;
          color_tag: string;
          consultation_required: boolean;
          created_at: string;
          deposit_kind: Database['public']['Enums']['deposit_kind'];
          deposit_value: number;
          description: string | null;
          id: string;
          is_combo: boolean;
          name: string;
          new_clients_only: boolean;
          position: number;
          price_cents: number | null;
          rebook_interval_days: number | null;
          salon_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          bookable_online?: boolean;
          buffer_after_minutes?: number;
          buffer_before_minutes?: number;
          category?: string;
          color_tag?: string;
          consultation_required?: boolean;
          created_at?: string;
          deposit_kind?: Database['public']['Enums']['deposit_kind'];
          deposit_value?: number;
          description?: string | null;
          id?: string;
          is_combo?: boolean;
          name: string;
          new_clients_only?: boolean;
          position?: number;
          price_cents?: number | null;
          rebook_interval_days?: number | null;
          salon_id: string;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          bookable_online?: boolean;
          buffer_after_minutes?: number;
          buffer_before_minutes?: number;
          category?: string;
          color_tag?: string;
          consultation_required?: boolean;
          created_at?: string;
          deposit_kind?: Database['public']['Enums']['deposit_kind'];
          deposit_value?: number;
          description?: string | null;
          id?: string;
          is_combo?: boolean;
          name?: string;
          new_clients_only?: boolean;
          position?: number;
          price_cents?: number | null;
          rebook_interval_days?: number | null;
          salon_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'services_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      settings: {
        Row: {
          auto_send_replies: boolean;
          autonomy: string;
          booking_link: string | null;
          booking_page_faq: string | null;
          booking_page_intro: string | null;
          booking_window_days: number;
          cancellation_window_hours: number;
          client_emails_enabled: boolean;
          client_reminder_hours: number[];
          client_self_service_enabled: boolean;
          created_at: string;
          currency: string;
          daily_agenda_enabled: boolean;
          deposits_enabled: boolean;
          followup_nudge_hours: number;
          hold_expiry_hours: number;
          low_stock_alerts_enabled: boolean;
          min_notice_minutes: number;
          payout_summary_enabled: boolean;
          preferences: NonNullable<Json>;
          public_booking_enabled: boolean;
          quiet_hours_enabled: boolean;
          quiet_hours_end: string;
          quiet_hours_start: string;
          reply_include_booking_link: boolean;
          reply_tone_examples: string | null;
          salon_id: string;
          slot_grid_minutes: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          auto_send_replies?: boolean;
          autonomy?: string;
          booking_link?: string | null;
          booking_page_faq?: string | null;
          booking_page_intro?: string | null;
          booking_window_days?: number;
          cancellation_window_hours?: number;
          client_emails_enabled?: boolean;
          client_reminder_hours?: number[];
          client_self_service_enabled?: boolean;
          created_at?: string;
          currency?: string;
          daily_agenda_enabled?: boolean;
          deposits_enabled?: boolean;
          followup_nudge_hours?: number;
          hold_expiry_hours?: number;
          low_stock_alerts_enabled?: boolean;
          min_notice_minutes?: number;
          payout_summary_enabled?: boolean;
          preferences?: NonNullable<Json>;
          public_booking_enabled?: boolean;
          quiet_hours_enabled?: boolean;
          quiet_hours_end?: string;
          quiet_hours_start?: string;
          reply_include_booking_link?: boolean;
          reply_tone_examples?: string | null;
          salon_id: string;
          slot_grid_minutes?: number;
          updated_at?: string;
        };
        Update: {
          auto_send_replies?: boolean;
          autonomy?: string;
          booking_link?: string | null;
          booking_page_faq?: string | null;
          booking_page_intro?: string | null;
          booking_window_days?: number;
          cancellation_window_hours?: number;
          client_emails_enabled?: boolean;
          client_reminder_hours?: number[];
          client_self_service_enabled?: boolean;
          created_at?: string;
          currency?: string;
          daily_agenda_enabled?: boolean;
          deposits_enabled?: boolean;
          followup_nudge_hours?: number;
          hold_expiry_hours?: number;
          low_stock_alerts_enabled?: boolean;
          min_notice_minutes?: number;
          payout_summary_enabled?: boolean;
          preferences?: NonNullable<Json>;
          public_booking_enabled?: boolean;
          quiet_hours_enabled?: boolean;
          quiet_hours_end?: string;
          quiet_hours_start?: string;
          reply_include_booking_link?: boolean;
          reply_tone_examples?: string | null;
          salon_id?: string;
          slot_grid_minutes?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'settings_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: true;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      stock_movements: {
        Row: {
          checkout_id: string | null;
          checkout_item_id: string | null;
          created_at: string;
          created_by: string | null;
          delta: number;
          id: string;
          note: string | null;
          on_hand_after: number;
          product_id: string;
          reason: Database['public']['Enums']['stock_movement_reason'];
          salon_id: string;
        };
        ComputedFields: never;
        Insert: {
          checkout_id?: string | null;
          checkout_item_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          delta: number;
          id?: string;
          note?: string | null;
          on_hand_after: number;
          product_id: string;
          reason: Database['public']['Enums']['stock_movement_reason'];
          salon_id: string;
        };
        Update: {
          checkout_id?: string | null;
          checkout_item_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          delta?: number;
          id?: string;
          note?: string | null;
          on_hand_after?: number;
          product_id?: string;
          reason?: Database['public']['Enums']['stock_movement_reason'];
          salon_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_movements_checkout_fkey';
            columns: ['salon_id', 'checkout_id'];
            isOneToOne: false;
            referencedRelation: 'checkouts';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'stock_movements_product_fkey';
            columns: ['salon_id', 'product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'stock_movements_product_fkey';
            columns: ['salon_id', 'product_id'];
            isOneToOne: false;
            referencedRelation: 'reorder_list';
            referencedColumns: ['salon_id', 'id'];
          },
          {
            foreignKeyName: 'stock_movements_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      stripe_accounts: {
        Row: {
          charges_enabled: boolean;
          country: string | null;
          created_at: string;
          default_currency: string | null;
          details_submitted: boolean;
          disabled_reason: string | null;
          payouts_enabled: boolean;
          requirements_due: string[];
          salon_id: string;
          stripe_account_id: string;
          terminal_location_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          charges_enabled?: boolean;
          country?: string | null;
          created_at?: string;
          default_currency?: string | null;
          details_submitted?: boolean;
          disabled_reason?: string | null;
          payouts_enabled?: boolean;
          requirements_due?: string[];
          salon_id: string;
          stripe_account_id: string;
          terminal_location_id?: string | null;
          updated_at?: string;
        };
        Update: {
          charges_enabled?: boolean;
          country?: string | null;
          created_at?: string;
          default_currency?: string | null;
          details_submitted?: boolean;
          disabled_reason?: string | null;
          payouts_enabled?: boolean;
          requirements_due?: string[];
          salon_id?: string;
          stripe_account_id?: string;
          terminal_location_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'stripe_accounts_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: true;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      work_hours_override: {
        Row: {
          blocks: NonNullable<Json>;
          breaks: NonNullable<Json>;
          created_at: string;
          end_date: string;
          id: string;
          kind: Database['public']['Enums']['work_hours_override_kind'];
          note: string | null;
          salon_id: string;
          start_date: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          blocks?: NonNullable<Json>;
          breaks?: NonNullable<Json>;
          created_at?: string;
          end_date: string;
          id?: string;
          kind?: Database['public']['Enums']['work_hours_override_kind'];
          note?: string | null;
          salon_id: string;
          start_date: string;
          updated_at?: string;
        };
        Update: {
          blocks?: NonNullable<Json>;
          breaks?: NonNullable<Json>;
          created_at?: string;
          end_date?: string;
          id?: string;
          kind?: Database['public']['Enums']['work_hours_override_kind'];
          note?: string | null;
          salon_id?: string;
          start_date?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'work_hours_override_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      work_hours_template: {
        Row: {
          blocks: NonNullable<Json>;
          breaks: NonNullable<Json>;
          created_at: string;
          salon_id: string;
          updated_at: string;
          weekday: number;
        };
        ComputedFields: never;
        Insert: {
          blocks?: NonNullable<Json>;
          breaks?: NonNullable<Json>;
          created_at?: string;
          salon_id: string;
          updated_at?: string;
          weekday: number;
        };
        Update: {
          blocks?: NonNullable<Json>;
          breaks?: NonNullable<Json>;
          created_at?: string;
          salon_id?: string;
          updated_at?: string;
          weekday?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'work_hours_template_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      client_summaries: {
        Row: {
          cancelled_count: number | null;
          client_id: string;
          last_visit_at: string | null;
          next_visit_at: string | null;
          no_show_count: number | null;
          paid_cents: number | null;
          salon_id: string;
          visit_count: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: 'clients_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
      reorder_list: {
        Row: {
          barcode: string | null;
          brand: string | null;
          category: string | null;
          cost_cents: number | null;
          id: string;
          name: string;
          on_hand: number;
          reorder_point: number;
          reorder_quantity: number | null;
          salon_id: string;
          sku: string | null;
          suggested_quantity: number | null;
          supplier: string | null;
          unit: string;
        };
        ComputedFields: never;
        Insert: {
          barcode?: string | null;
          brand?: string | null;
          category?: string | null;
          cost_cents?: number | null;
          id?: string | null;
          name?: string | null;
          on_hand?: number | null;
          reorder_point?: number | null;
          reorder_quantity?: number | null;
          salon_id?: string | null;
          sku?: string | null;
          suggested_quantity?: never;
          supplier?: string | null;
          unit?: string | null;
        };
        Update: {
          barcode?: string | null;
          brand?: string | null;
          category?: string | null;
          cost_cents?: number | null;
          id?: string | null;
          name?: string | null;
          on_hand?: number | null;
          reorder_point?: number | null;
          reorder_quantity?: number | null;
          salon_id?: string | null;
          sku?: string | null;
          suggested_quantity?: never;
          supplier?: string | null;
          unit?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'products_salon_id_fkey';
            columns: ['salon_id'];
            isOneToOne: false;
            referencedRelation: 'salons';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Functions: {
      adjust_stock: {
        Args: {
          p_delta: number;
          p_note?: string;
          p_product_id: string;
          p_reason?: Database['public']['Enums']['stock_movement_reason'];
        };
        Returns: {
          checkout_id: string | null;
          checkout_item_id: string | null;
          created_at: string;
          created_by: string | null;
          delta: number;
          id: string;
          note: string | null;
          on_hand_after: number;
          product_id: string;
          reason: Database['public']['Enums']['stock_movement_reason'];
          salon_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'stock_movements';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      ai_tokens_used_this_month: { Args: { p_salon_id: string }; Returns: number };
      apply_running_late: {
        Args: { p_delay_minutes: number; p_moves: Json; p_salon_id: string; p_strategy?: string };
        Returns: {
          cancel_reason: string | null;
          cancelled_at: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          hold_expires_at: string | null;
          id: string;
          import_key: string | null;
          manage_token: string;
          notes: string | null;
          price_cents: number | null;
          requested_at: string | null;
          salon_id: string;
          services: NonNullable<Json>;
          source: Database['public']['Enums']['appointment_source'];
          starts_at: string;
          status: Database['public']['Enums']['appointment_status'];
          stylist_id: string;
          text_reminder_sent_at: string | null;
          updated_at: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'appointments';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      appointment_forms: { Args: { p_appointment_id: string }; Returns: Json };
      appointments_missing_forms: {
        Args: { p_from: string; p_salon_id: string; p_to: string };
        Returns: Json;
      };
      book_appointment: {
        Args: {
          p_client_id: string;
          p_notes?: string;
          p_price_cents?: number;
          p_salon_id: string;
          p_segments: Json;
          p_services?: Json;
          p_source?: Database['public']['Enums']['appointment_source'];
          p_status?: Database['public']['Enums']['appointment_status'];
          p_stylist_id?: string;
        };
        Returns: {
          cancel_reason: string | null;
          cancelled_at: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          hold_expires_at: string | null;
          id: string;
          import_key: string | null;
          manage_token: string;
          notes: string | null;
          price_cents: number | null;
          requested_at: string | null;
          salon_id: string;
          services: NonNullable<Json>;
          source: Database['public']['Enums']['appointment_source'];
          starts_at: string;
          status: Database['public']['Enums']['appointment_status'];
          stylist_id: string;
          text_reminder_sent_at: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'appointments';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      book_public_appointment: {
        Args: { p_booking: Json; p_max_upcoming?: number; p_salon_id: string; p_user_id: string };
        Returns: Json;
      };
      cancel_appointment_with_policy: {
        Args: { p_appointment_id: string; p_deposit?: string; p_reason?: string };
        Returns: Json;
      };
      cancel_booking_by_token: { Args: { p_token: string }; Returns: Json };
      cancellation_quote: { Args: { p_appointment_id: string }; Returns: Json };
      capture_inbox_request: { Args: { p_request: Json; p_salon_id: string }; Returns: Json };
      claim_client_emails: { Args: { p_limit?: number }; Returns: Json };
      claim_notifications: {
        Args: { p_limit?: number };
        Returns: {
          appointment_id: string | null;
          attempts: number;
          body: string;
          category: string | null;
          claimed_at: string | null;
          created_at: string;
          data: NonNullable<Json>;
          dedupe_key: string;
          id: string;
          kind: Database['public']['Enums']['notification_kind'];
          last_error: string | null;
          salon_id: string;
          send_after: string;
          sent_at: string | null;
          status: Database['public']['Enums']['notification_status'];
          tickets: Json | null;
          title: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'notifications_outbox';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      complete_card_checkout: {
        Args: {
          p_card_brand?: string;
          p_card_last4?: string;
          p_checkout_id: string;
          p_payment_intent_id: string;
        };
        Returns: {
          amount_due_cents: number;
          appointment_id: string | null;
          card_brand: string | null;
          card_last4: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          deposit_cents: number;
          id: string;
          method: Database['public']['Enums']['checkout_method'] | null;
          paid_at: string | null;
          rebook_appointment_id: string | null;
          rebook_declined_at: string | null;
          receipt_token: string;
          salon_id: string;
          status: Database['public']['Enums']['checkout_status'];
          stripe_payment_intent_id: string | null;
          subtotal_cents: number;
          tip_cents: number;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'checkouts';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      count_stock: {
        Args: { p_note?: string; p_on_hand: number; p_product_id: string };
        Returns: {
          checkout_id: string | null;
          checkout_item_id: string | null;
          created_at: string;
          created_by: string | null;
          delta: number;
          id: string;
          note: string | null;
          on_hand_after: number;
          product_id: string;
          reason: Database['public']['Enums']['stock_movement_reason'];
          salon_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'stock_movements';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_salon: {
        Args: { p_name: string; p_slug: string; p_timezone: string };
        Returns: {
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          slug: string;
          timezone: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'salons';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      delete_ai_provider_config: { Args: { p_salon_id: string }; Returns: undefined };
      deposit_pay_page: { Args: { p_token: string }; Returns: Json };
      finish_client_emails: { Args: { p_results: Json }; Returns: number };
      finish_notifications: { Args: { p_results: Json }; Returns: number };
      get_ai_provider_secret: {
        Args: { p_salon_id: string };
        Returns: {
          api_key: string;
          model: string;
          monthly_token_budget: number;
          provider: Database['public']['Enums']['ai_provider'];
        }[];
      };
      get_receipt: { Args: { p_token: string }; Returns: Json };
      hit_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number };
        Returns: boolean;
      };
      import_appointments: { Args: { p_appointments: Json; p_salon_id: string }; Returns: Json };
      import_clients: { Args: { p_clients: Json; p_salon_id: string }; Returns: Json };
      inbox_bridge_for_token: {
        Args: { p_bridge_version?: string; p_hourly_limit?: number; p_token: string };
        Returns: {
          auto_reply: boolean;
          keyword: string;
          rate_limited: boolean;
          salon_id: string;
          salon_name: string;
          timezone: string;
        }[];
      };
      install_starter_forms: { Args: { p_salon_id: string }; Returns: number };
      is_salon_slug_available: { Args: { p_slug: string }; Returns: boolean };
      manage_booking: { Args: { p_token: string }; Returns: Json };
      mark_deposit_paid: {
        Args: {
          p_customer_id?: string;
          p_deposit_id: string;
          p_payment_intent_id: string;
          p_payment_method_id?: string;
        };
        Returns: {
          amount_cents: number;
          appointment_id: string;
          created_at: string;
          currency: string;
          id: string;
          paid_at: string | null;
          pay_token: string;
          refunded_cents: number;
          resolution: string | null;
          resolved_at: string | null;
          salon_id: string;
          status: Database['public']['Enums']['deposit_status'];
          status_after: Database['public']['Enums']['appointment_status'];
          stripe_checkout_session_id: string | null;
          stripe_customer_id: string | null;
          stripe_payment_intent_id: string | null;
          stripe_payment_method_id: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'appointment_deposits';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      mark_deposit_refunded: {
        Args: { p_deposit_id: string; p_refunded_cents: number; p_resolution?: string };
        Returns: {
          amount_cents: number;
          appointment_id: string;
          created_at: string;
          currency: string;
          id: string;
          paid_at: string | null;
          pay_token: string;
          refunded_cents: number;
          resolution: string | null;
          resolved_at: string | null;
          salon_id: string;
          status: Database['public']['Enums']['deposit_status'];
          status_after: Database['public']['Enums']['appointment_status'];
          stripe_checkout_session_id: string | null;
          stripe_customer_id: string | null;
          stripe_payment_intent_id: string | null;
          stripe_payment_method_id: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'appointment_deposits';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      mark_text_reminder_sent: {
        Args: { p_appointment_id: string; p_sent?: boolean };
        Returns: string;
      };
      pay_checkout_offline: {
        Args: { p_checkout_id: string; p_method: Database['public']['Enums']['checkout_method'] };
        Returns: {
          amount_due_cents: number;
          appointment_id: string | null;
          card_brand: string | null;
          card_last4: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          deposit_cents: number;
          id: string;
          method: Database['public']['Enums']['checkout_method'] | null;
          paid_at: string | null;
          rebook_appointment_id: string | null;
          rebook_declined_at: string | null;
          receipt_token: string;
          salon_id: string;
          status: Database['public']['Enums']['checkout_status'];
          stripe_payment_intent_id: string | null;
          subtotal_cents: number;
          tip_cents: number;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'checkouts';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      payout_summary: { Args: { p_day?: string; p_salon_id: string }; Returns: Json };
      public_appointment_forms: { Args: { p_token: string }; Returns: Json };
      public_booking_page: { Args: { p_slug: string }; Returns: Json };
      public_client_bookings: { Args: { p_salon_id: string; p_user_id: string }; Returns: Json };
      rebook_from_checkout: {
        Args: {
          p_checkout_id: string;
          p_price_cents?: number;
          p_segments: Json;
          p_services?: Json;
          p_status?: Database['public']['Enums']['appointment_status'];
        };
        Returns: {
          cancel_reason: string | null;
          cancelled_at: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          hold_expires_at: string | null;
          id: string;
          import_key: string | null;
          manage_token: string;
          notes: string | null;
          price_cents: number | null;
          requested_at: string | null;
          salon_id: string;
          services: NonNullable<Json>;
          source: Database['public']['Enums']['appointment_source'];
          starts_at: string;
          status: Database['public']['Enums']['appointment_status'];
          stylist_id: string;
          text_reminder_sent_at: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'appointments';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      rebook_stats: { Args: { p_from?: string; p_salon_id: string; p_to?: string }; Returns: Json };
      record_client_reply: {
        Args: { p_reply: Json; p_salon_id: string };
        Returns: {
          appointment_id: string | null;
          body: string | null;
          captured_request_id: string | null;
          channel: string;
          claimed_at: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          kind: string;
          salon_id: string;
          sent_at: string | null;
          source: string | null;
          status: string;
          to_phone: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'client_replies';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      register_push_token: {
        Args: {
          p_platform: Database['public']['Enums']['push_platform'];
          p_salon_id: string;
          p_token: string;
        };
        Returns: {
          created_at: string;
          id: string;
          last_seen_at: string;
          platform: Database['public']['Enums']['push_platform'];
          salon_id: string;
          token: string;
          user_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'push_tokens';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      reminder_queue: { Args: { p_day?: string; p_salon_id: string }; Returns: Json };
      reschedule_appointment: {
        Args: {
          p_appointment_id: string;
          p_price_cents?: number;
          p_segments: Json;
          p_services?: Json;
        };
        Returns: {
          cancel_reason: string | null;
          cancelled_at: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          hold_expires_at: string | null;
          id: string;
          import_key: string | null;
          manage_token: string;
          notes: string | null;
          price_cents: number | null;
          requested_at: string | null;
          salon_id: string;
          services: NonNullable<Json>;
          source: Database['public']['Enums']['appointment_source'];
          starts_at: string;
          status: Database['public']['Enums']['appointment_status'];
          stylist_id: string;
          text_reminder_sent_at: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'appointments';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      reschedule_booking_by_token: { Args: { p_segments: Json; p_token: string }; Returns: Json };
      resolve_captured_request: {
        Args: { p_action: string; p_request_id: string };
        Returns: {
          appointment_id: string | null;
          channel: string;
          client_created: boolean;
          client_id: string | null;
          created_at: string;
          dedupe_key: string;
          id: string;
          intent: Database['public']['Enums']['captured_request_intent'];
          message: string;
          note: string | null;
          parsed: NonNullable<Json>;
          received_at: string;
          resolved_at: string | null;
          salon_id: string;
          sender: string | null;
          sender_phone: string | null;
          status: Database['public']['Enums']['captured_request_status'];
          target_appointment_id: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'captured_requests';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      rotate_inbox_bridge_token: { Args: { p_salon_id: string }; Returns: string };
      save_ai_provider_config: {
        Args: {
          p_api_key?: string;
          p_model: string;
          p_monthly_token_budget: number;
          p_provider: Database['public']['Enums']['ai_provider'];
          p_salon_id: string;
        };
        Returns: {
          created_at: string;
          key_hint: string;
          key_updated_at: string;
          model: string;
          monthly_token_budget: number;
          provider: Database['public']['Enums']['ai_provider'];
          salon_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: '*';
          to: 'ai_provider_config';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      save_service: { Args: { p_salon_id: string; p_service: Json }; Returns: string };
      save_service_addon: { Args: { p_addon: Json; p_salon_id: string }; Returns: string };
      search_salon: {
        Args: { p_limit?: number; p_query: string; p_salon_id: string };
        Returns: {
          color_tag: string;
          id: string;
          kind: string;
          score: number;
          starts_at: string;
          status: Database['public']['Enums']['appointment_status'];
          subtitle: string;
          title: string;
        }[];
      };
      set_appointment_status: {
        Args: {
          p_appointment_id: string;
          p_reason?: string;
          p_status: Database['public']['Enums']['appointment_status'];
        };
        Returns: {
          cancel_reason: string | null;
          cancelled_at: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string;
          hold_expires_at: string | null;
          id: string;
          import_key: string | null;
          manage_token: string;
          notes: string | null;
          price_cents: number | null;
          requested_at: string | null;
          salon_id: string;
          services: NonNullable<Json>;
          source: Database['public']['Enums']['appointment_source'];
          starts_at: string;
          status: Database['public']['Enums']['appointment_status'];
          stylist_id: string;
          text_reminder_sent_at: string | null;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'appointments';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      skip_rebook: {
        Args: { p_checkout_id: string };
        Returns: {
          amount_due_cents: number;
          appointment_id: string | null;
          card_brand: string | null;
          card_last4: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          deposit_cents: number;
          id: string;
          method: Database['public']['Enums']['checkout_method'] | null;
          paid_at: string | null;
          rebook_appointment_id: string | null;
          rebook_declined_at: string | null;
          receipt_token: string;
          salon_id: string;
          status: Database['public']['Enums']['checkout_status'];
          stripe_payment_intent_id: string | null;
          subtotal_cents: number;
          tip_cents: number;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'checkouts';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      start_checkout: {
        Args: { p_appointment_id: string };
        Returns: {
          amount_due_cents: number;
          appointment_id: string | null;
          card_brand: string | null;
          card_last4: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          deposit_cents: number;
          id: string;
          method: Database['public']['Enums']['checkout_method'] | null;
          paid_at: string | null;
          rebook_appointment_id: string | null;
          rebook_declined_at: string | null;
          receipt_token: string;
          salon_id: string;
          status: Database['public']['Enums']['checkout_status'];
          stripe_payment_intent_id: string | null;
          subtotal_cents: number;
          tip_cents: number;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'checkouts';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      submit_public_form: {
        Args: { p_answers: Json; p_template_id: string; p_token: string };
        Returns: Json;
      };
      update_checkout: {
        Args: { p_checkout_id: string; p_items: Json; p_tip_cents?: number };
        Returns: {
          amount_due_cents: number;
          appointment_id: string | null;
          card_brand: string | null;
          card_last4: string | null;
          client_id: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          deposit_cents: number;
          id: string;
          method: Database['public']['Enums']['checkout_method'] | null;
          paid_at: string | null;
          rebook_appointment_id: string | null;
          rebook_declined_at: string | null;
          receipt_token: string;
          salon_id: string;
          status: Database['public']['Enums']['checkout_status'];
          stripe_payment_intent_id: string | null;
          subtotal_cents: number;
          tip_cents: number;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'checkouts';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
    };
    Enums: {
      addon_placement: 'before_finish' | 'end';
      ai_provider: 'openai' | 'anthropic' | 'gemini';
      appointment_segment_kind: 'busy' | 'processing' | 'style' | 'buffer';
      appointment_source: 'owner' | 'inbox' | 'public' | 'import';
      appointment_status:
        'held' | 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
      captured_request_intent: 'booking' | 'reschedule' | 'cancel';
      captured_request_status: 'pending' | 'approved' | 'declined' | 'expired' | 'dismissed';
      checkout_item_kind: 'service' | 'addon' | 'retail' | 'custom';
      checkout_method: 'card' | 'cash' | 'other';
      checkout_status: 'open' | 'paid' | 'canceled';
      client_email_kind:
        'confirmation' | 'reminder' | 'rescheduled' | 'cancellation' | 'forms_request';
      deposit_kind: 'none' | 'flat' | 'percent';
      deposit_status: 'pending' | 'paid' | 'refund_due' | 'refunded' | 'kept' | 'canceled';
      notification_kind:
        | 'request'
        | 'request_nudge'
        | 'cancellation'
        | 'daily_agenda'
        | 'payout_summary'
        | 'public_booking'
        | 'deposit_paid'
        | 'client_rescheduled'
        | 'low_stock';
      notification_status: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed';
      payment_status:
        | 'pending'
        | 'processing'
        | 'succeeded'
        | 'failed'
        | 'canceled'
        | 'partially_refunded'
        | 'refunded';
      push_platform: 'ios' | 'android' | 'web';
      salon_role: 'owner' | 'stylist';
      segment_kind: 'busy' | 'processing' | 'style';
      stock_movement_reason: 'receive' | 'sale' | 'adjust' | 'count' | 'use' | 'return';
      work_hours_override_kind: 'custom' | 'day_off' | 'vacation';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      addon_placement: ['before_finish', 'end'],
      ai_provider: ['openai', 'anthropic', 'gemini'],
      appointment_segment_kind: ['busy', 'processing', 'style', 'buffer'],
      appointment_source: ['owner', 'inbox', 'public', 'import'],
      appointment_status: ['held', 'requested', 'confirmed', 'completed', 'cancelled', 'no_show'],
      captured_request_intent: ['booking', 'reschedule', 'cancel'],
      captured_request_status: ['pending', 'approved', 'declined', 'expired', 'dismissed'],
      checkout_item_kind: ['service', 'addon', 'retail', 'custom'],
      checkout_method: ['card', 'cash', 'other'],
      checkout_status: ['open', 'paid', 'canceled'],
      client_email_kind: [
        'confirmation',
        'reminder',
        'rescheduled',
        'cancellation',
        'forms_request',
      ],
      deposit_kind: ['none', 'flat', 'percent'],
      deposit_status: ['pending', 'paid', 'refund_due', 'refunded', 'kept', 'canceled'],
      notification_kind: [
        'request',
        'request_nudge',
        'cancellation',
        'daily_agenda',
        'payout_summary',
        'public_booking',
        'deposit_paid',
        'client_rescheduled',
        'low_stock',
      ],
      notification_status: ['pending', 'sending', 'sent', 'skipped', 'failed'],
      payment_status: [
        'pending',
        'processing',
        'succeeded',
        'failed',
        'canceled',
        'partially_refunded',
        'refunded',
      ],
      push_platform: ['ios', 'android', 'web'],
      salon_role: ['owner', 'stylist'],
      segment_kind: ['busy', 'processing', 'style'],
      stock_movement_reason: ['receive', 'sale', 'adjust', 'count', 'use', 'return'],
      work_hours_override_kind: ['custom', 'day_off', 'vacation'],
    },
  },
} as const;
