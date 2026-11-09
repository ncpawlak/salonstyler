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
          description: string | null;
          id: string;
          is_combo: boolean;
          name: string;
          new_clients_only: boolean;
          position: number;
          price_cents: number | null;
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
          description?: string | null;
          id?: string;
          is_combo?: boolean;
          name: string;
          new_clients_only?: boolean;
          position?: number;
          price_cents?: number | null;
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
          description?: string | null;
          id?: string;
          is_combo?: boolean;
          name?: string;
          new_clients_only?: boolean;
          position?: number;
          price_cents?: number | null;
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
          autonomy: string;
          booking_window_days: number;
          created_at: string;
          currency: string;
          followup_nudge_hours: number;
          hold_expiry_hours: number;
          min_notice_minutes: number;
          preferences: NonNullable<Json>;
          salon_id: string;
          slot_grid_minutes: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          autonomy?: string;
          booking_window_days?: number;
          created_at?: string;
          currency?: string;
          followup_nudge_hours?: number;
          hold_expiry_hours?: number;
          min_notice_minutes?: number;
          preferences?: NonNullable<Json>;
          salon_id: string;
          slot_grid_minutes?: number;
          updated_at?: string;
        };
        Update: {
          autonomy?: string;
          booking_window_days?: number;
          created_at?: string;
          currency?: string;
          followup_nudge_hours?: number;
          hold_expiry_hours?: number;
          min_notice_minutes?: number;
          preferences?: NonNullable<Json>;
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
      [_ in never]: never;
    };
    Functions: {
      ai_tokens_used_this_month: { Args: { p_salon_id: string }; Returns: number };
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
      get_ai_provider_secret: {
        Args: { p_salon_id: string };
        Returns: {
          api_key: string;
          model: string;
          monthly_token_budget: number;
          provider: Database['public']['Enums']['ai_provider'];
        }[];
      };
      is_salon_slug_available: { Args: { p_slug: string }; Returns: boolean };
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
    };
    Enums: {
      addon_placement: 'before_finish' | 'end';
      ai_provider: 'openai' | 'anthropic' | 'gemini';
      push_platform: 'ios' | 'android' | 'web';
      salon_role: 'owner' | 'stylist';
      segment_kind: 'busy' | 'processing' | 'style';
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
      push_platform: ['ios', 'android', 'web'],
      salon_role: ['owner', 'stylist'],
      segment_kind: ['busy', 'processing', 'style'],
      work_hours_override_kind: ['custom', 'day_off', 'vacation'],
    },
  },
} as const;
